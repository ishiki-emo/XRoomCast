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
import { DurableObject } from 'cloudflare:workers';

interface Env {
  ASSETS: Fetcher;
  VRM_BUCKET: R2Bucket;
  SFU_STATE: KVNamespace;
  PRESENCE: DurableObjectNamespace;
  VRM_TOKEN?: string;
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_APP_SECRET?: string;
  BRIDGE_TOKEN?: string;
  /** 視聴用の短縮パス /watch/<キー> の照合キー(secret) */
  WATCH_KEY?: string;
  /** 配信者コンソール /broadcast/<キー> と音声パブリッシュの照合キー(secret) */
  BROADCAST_KEY?: string;
  /** /watch で使う既定VRMのR2キー(wrangler.jsoncのvars) */
  DEFAULT_VRM_KEY?: string;
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

async function cfApi(
  env: Env,
  path: string,
  body: unknown,
  method: 'POST' | 'PUT' = 'POST',
): Promise<Record<string, unknown>> {
  const res = await fetch(`${API_BASE}/${env.CF_REALTIME_APP_ID}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${env.CF_REALTIME_APP_SECRET}`,
      'Content-Type': 'application/json',
    },
    // 空セッション作成はボディ自体を省略する必要がある(空JSONは400になる)
    body: body === undefined ? undefined : JSON.stringify(body),
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

const AUDIO_PUBLISHER_KEY = 'audio-publisher';

interface AudioPublisherRecord {
  sessionId: string;
  trackName: string;
  updatedAt: number;
}

async function readPublisher(env: Env): Promise<PublisherRecord | null> {
  const record = await env.SFU_STATE.get<PublisherRecord>(PUBLISHER_KEY, 'json');
  if (!record || Date.now() - record.updatedAt > PUBLISHER_FRESH_MS) return null;
  return record;
}

async function readAudioPublisher(env: Env): Promise<AudioPublisherRecord | null> {
  const record = await env.SFU_STATE.get<AudioPublisherRecord>(AUDIO_PUBLISHER_KEY, 'json');
  if (!record || Date.now() - record.updatedAt > PUBLISHER_FRESH_MS) return null;
  return record;
}

function isBroadcaster(env: Env, request: Request, url: URL): boolean {
  if (!env.BROADCAST_KEY) return false;
  if (request.headers.get('Authorization') === `Bearer ${env.BROADCAST_KEY}`) return true;
  // sendBeacon用(ヘッダを付けられないためクエリで受ける)
  return url.searchParams.get('key') === env.BROADCAST_KEY;
}

/** 音声パブリッシャーの登録/解除(bodyのsessionIdがnullなら解除) */
async function handleAudioPublisherUpdate(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as { sessionId?: string | null; trackName?: string };
  if (!body.sessionId) {
    await env.SFU_STATE.delete(AUDIO_PUBLISHER_KEY);
    return json(200, { ok: true, cleared: true });
  }
  const record: AudioPublisherRecord = {
    sessionId: String(body.sessionId),
    trackName: String(body.trackName ?? 'mic'),
    updatedAt: Date.now(),
  };
  await env.SFU_STATE.put(AUDIO_PUBLISHER_KEY, JSON.stringify(record));
  return json(200, { ok: true });
}

async function handleSfuApi(request: Request, env: Env, url: URL): Promise<Response> {
  const sfuConfigured = Boolean(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_SECRET);

  if (request.method === 'GET' && url.pathname === '/api/sfu/status') {
    const audio = await readAudioPublisher(env);
    return json(200, {
      enabled: sfuConfigured,
      publisherReady: (await readPublisher(env)) !== null,
      audio: audio ? { sessionId: audio.sessionId, trackName: audio.trackName } : null,
    });
  }

  // 音声パブリッシャーの登録/解除(配信者コンソールから。要BROADCAST_KEY)
  if (
    request.method === 'POST' &&
    (url.pathname === '/api/sfu/audio-publisher' || url.pathname === '/api/sfu/audio-publisher-beacon')
  ) {
    if (!isBroadcaster(env, request, url)) return json(403, { error: 'forbidden' });
    return handleAudioPublisherUpdate(request, env);
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
    // sdpなし(空セッション作成→後からtracks/newでSDP交換)にも対応する
    const body = (await request.json()) as { sdp?: string };
    const session = await cfApi(
      env,
      '/sessions/new',
      body.sdp ? { sessionDescription: { type: 'offer', sdp: String(body.sdp) } } : undefined,
    );
    const desc = session.sessionDescription as { sdp: string } | undefined;
    return json(200, { sessionId: session.sessionId, sdp: desc?.sdp ?? null });
  }

  // トラックの公開(local)/購読(remote)。localの公開はBROADCAST_KEY必須
  if (request.method === 'POST' && url.pathname === '/api/sfu/tracks/new') {
    const body = (await request.json()) as {
      sessionId?: string;
      sessionDescription?: { type: string; sdp: string };
      tracks?: { location?: string }[];
    };
    if (!body.sessionId || !Array.isArray(body.tracks)) {
      return json(400, { error: 'sessionId / tracks がありません' });
    }
    const publishesLocal = body.tracks.some((t) => t.location === 'local');
    if (publishesLocal && !isBroadcaster(env, request, url)) {
      return json(403, { error: 'forbidden(トラック公開にはBROADCAST_KEYが必要です)' });
    }
    const payload: Record<string, unknown> = { tracks: body.tracks };
    if (body.sessionDescription) payload.sessionDescription = body.sessionDescription;
    const result = await cfApi(env, `/sessions/${String(body.sessionId)}/tracks/new`, payload);
    return json(200, result);
  }

  // 再ネゴシエーション(リモートトラック購読時にサーバーからのofferへ答える)
  if (request.method === 'POST' && url.pathname === '/api/sfu/renegotiate') {
    const body = (await request.json()) as { sessionId?: string; sdp?: string };
    if (!body.sessionId || !body.sdp) return json(400, { error: 'sessionId / sdp がありません' });
    const result = await cfApi(
      env,
      `/sessions/${String(body.sessionId)}/renegotiate`,
      { sessionDescription: { type: 'answer', sdp: String(body.sdp) } },
      'PUT',
    );
    return json(200, result);
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

interface ChatItem {
  text: string;
  ts: number;
}

const CHAT_HISTORY_KEY = 'chat-history';
const CHAT_HISTORY_MAX = 50;
const CHAT_TEXT_MAX = 200;
const CHAT_MIN_INTERVAL_MS = 1000;

/**
 * 同接カウント+匿名コメント用のDurable Object。
 * 視聴ページがWebSocketで接続し、
 * - 同接: 開いているソケット数を増減のたびに全員へ配信
 * - コメント: 受信を検証(長さ・1秒レート制限)して全員へ配信。
 *   直近50件はストレージに保存し、接続時に履歴として送る
 * ハイバネーションAPIを使うので接続が張りっぱなしでもアイドルコストはほぼゼロ。
 */
export class Presence extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // クライアントの生存確認ping/pongはDOを起こさずランタイムが自動応答する
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.broadcastCount();
    const history = (await this.ctx.storage.get<ChatItem[]>(CHAT_HISTORY_KEY)) ?? [];
    pair[1].send(JSON.stringify({ type: 'history', items: history }));
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    let data: { type?: string; text?: string };
    try {
      data = JSON.parse(message) as { type?: string; text?: string };
    } catch {
      return;
    }
    if (data.type !== 'chat' || typeof data.text !== 'string') return;

    const text = data.text.trim().slice(0, CHAT_TEXT_MAX);
    if (text.length === 0) return;

    // ソケット単位のレート制限(ハイバネーション耐性のためattachmentに記録)
    const attachment = (ws.deserializeAttachment() ?? {}) as { lastChatAt?: number };
    const now = Date.now();
    if (attachment.lastChatAt !== undefined && now - attachment.lastChatAt < CHAT_MIN_INTERVAL_MS) {
      return;
    }
    ws.serializeAttachment({ ...attachment, lastChatAt: now });

    const item: ChatItem = { text, ts: now };
    const history = (await this.ctx.storage.get<ChatItem[]>(CHAT_HISTORY_KEY)) ?? [];
    history.push(item);
    await this.ctx.storage.put(CHAT_HISTORY_KEY, history.slice(-CHAT_HISTORY_MAX));

    this.broadcastJson({ type: 'chat', ...item });
  }

  override webSocketClose(ws: WebSocket): void {
    this.broadcastCount(ws);
  }

  override webSocketError(ws: WebSocket): void {
    this.broadcastCount(ws);
  }

  private broadcastCount(closing?: WebSocket): void {
    const count = this.ctx.getWebSockets().filter((s) => s !== closing).length;
    // 旧クライアント互換のため count フィールドはトップレベルに残す
    this.broadcastJson({ type: 'count', count }, closing);
  }

  private broadcastJson(payload: unknown, closing?: WebSocket): void {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === closing) continue;
      try {
        socket.send(message);
      } catch {
        // 送信失敗はclose側のハンドラに任せる
      }
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 同接カウント(WebSocket)。単一ルーム'main'のDurable Objectへ委譲
    if (url.pathname === '/api/presence') {
      return env.PRESENCE.get(env.PRESENCE.idFromName('main')).fetch(request);
    }

    // 視聴用の短縮URL: /watch/<キー> を開くだけで、VRMトークン入りの
    // 視聴パラメータ付きURLへリダイレクトする(秘密はすべてWorker側に置く)
    if (url.pathname.startsWith('/watch/')) {
      const key = decodeURIComponent(url.pathname.slice('/watch/'.length));
      if (!env.WATCH_KEY || key !== env.WATCH_KEY) {
        return new Response('not found', { status: 404 });
      }
      const vrmKey = env.DEFAULT_VRM_KEY ?? 'Emo.vrm';
      const vrmParam = encodeURIComponent(`/vrm/${vrmKey}?k=${env.VRM_TOKEN ?? ''}`);
      return Response.redirect(`${url.origin}/?vrm=${vrmParam}&transport=sfu&watch=1`, 302);
    }

    // 配信者コンソール(音声)の短縮URL
    if (url.pathname.startsWith('/broadcast/')) {
      const key = decodeURIComponent(url.pathname.slice('/broadcast/'.length));
      if (!env.BROADCAST_KEY || key !== env.BROADCAST_KEY) {
        return new Response('not found', { status: 404 });
      }
      return Response.redirect(`${url.origin}/broadcast.html?key=${encodeURIComponent(key)}`, 302);
    }

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
