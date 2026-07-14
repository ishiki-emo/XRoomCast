/**
 * ビューアWorker:
 * 1. 静的アセット配信(ビューア本体)
 * 2. R2非公開バケットからのVRM配信(/vrm/<キー>?k=<トークン>)
 * 3. Cloudflare Realtime SFUのプロキシ(/api/sfu/*)
 *    - App Secretはこの Worker のsecretに置き、ブラウザへは出さない
 *    - パブリッシャー(ブリッジ)のセッションIDはKVで共有する。
 *      登録はBRIDGE_TOKENによるBearer認証必須(配信の乗っ取り防止)
 *    - これによりブリッジのトンネル公開が不要になる(共有リンクが固定化)
 */
interface Env {
  ASSETS: Fetcher;
  VRM_BUCKET: R2Bucket;
  SFU_STATE: KVNamespace;
  VRM_TOKEN?: string;
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_APP_SECRET?: string;
  BRIDGE_TOKEN?: string;
}

const API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const DATA_CHANNEL_NAME = 'pose';
const PUBLISHER_KEY = 'publisher';
/** ブリッジのハートビート(5分間隔)がこの時間途絶えたらパブリッシャー不在とみなす */
const PUBLISHER_FRESH_MS = 15 * 60 * 1000;

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

async function cfApi(env: Env, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/${env.CF_REALTIME_APP_ID}${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`Cloudflare API ${path} が失敗: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

interface PublisherRecord {
  sessionId: string;
  updatedAt: number;
}

async function readPublisher(env: Env): Promise<PublisherRecord | null> {
  const record = await env.SFU_STATE.get<PublisherRecord>(PUBLISHER_KEY, 'json');
  if (!record || Date.now() - record.updatedAt > PUBLISHER_FRESH_MS) return null;
  return record;
}

async function handleSfuApi(request: Request, env: Env, url: URL): Promise<Response> {
  const sfuConfigured = Boolean(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_SECRET);

  if (request.method === 'GET' && url.pathname === '/api/sfu/status') {
    return json(200, {
      enabled: sfuConfigured,
      publisherReady: (await readPublisher(env)) !== null,
    });
  }

  // ブリッジからのパブリッシャーセッションID登録(Bearer認証必須)
  if (request.method === 'POST' && url.pathname === '/api/sfu/publisher') {
    if (!env.BRIDGE_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.BRIDGE_TOKEN}`) {
      return json(403, { error: 'forbidden' });
    }
    const body = (await request.json()) as { sessionId?: string };
    if (!body.sessionId) return json(400, { error: 'sessionIdがありません' });
    const record: PublisherRecord = { sessionId: body.sessionId, updatedAt: Date.now() };
    await env.SFU_STATE.put(PUBLISHER_KEY, JSON.stringify(record));
    return json(200, { ok: true });
  }

  if (!sfuConfigured) {
    return json(503, { error: 'SFU未設定(WorkerにCF_REALTIME_*のsecretを設定してください)' });
  }

  if (request.method === 'POST' && url.pathname === '/api/sfu/sessions/new') {
    const body = (await request.json()) as { sdp?: string };
    const session = await cfApi(env, '/sessions/new', {
      sessionDescription: { type: 'offer', sdp: String(body.sdp) },
    });
    const desc = session.sessionDescription as { sdp: string };
    return json(200, { sessionId: session.sessionId, sdp: desc.sdp });
  }

  if (request.method === 'POST' && url.pathname === '/api/sfu/subscribe') {
    const publisher = await readPublisher(env);
    if (!publisher) {
      return json(503, { error: 'パブリッシャーが未登録です(ブリッジが起動しているか確認)' });
    }
    const body = (await request.json()) as { sessionId?: string };
    const result = await cfApi(env, `/sessions/${String(body.sessionId)}/datachannels/new`, {
      dataChannels: [
        { location: 'remote', sessionId: publisher.sessionId, dataChannelName: DATA_CHANNEL_NAME },
      ],
    });
    const channels = result.dataChannels as { id: number }[];
    const channelId = channels[0]?.id;
    if (channelId === undefined) {
      return json(502, { error: 'DataChannel IDが取得できませんでした' });
    }
    return json(200, { id: channelId, name: DATA_CHANNEL_NAME });
  }

  return json(404, { error: 'not found' });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/sfu/')) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      try {
        return await handleSfuApi(request, env, url);
      } catch (error) {
        return json(500, { error: String(error) });
      }
    }

    if (url.pathname.startsWith('/vrm/')) {
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
      }
      // トークン未設定時は配信自体を無効にする(安全側)
      if (!env.VRM_TOKEN || url.searchParams.get('k') !== env.VRM_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const key = decodeURIComponent(url.pathname.slice('/vrm/'.length));
      const object = await env.VRM_BUCKET.get(key);
      if (!object) {
        return new Response('not found', { status: 404 });
      }
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(object.size),
          'Cache-Control': 'private, no-store',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
