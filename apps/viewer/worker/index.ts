/**
 * ビューアWorker:
 * 1. 静的アセット配信(ビューア本体)
 * 2. R2非公開バケットからのVRM配信(/vrm/<キー>?k=<トークン>)
 * 3. Cloudflare Realtime SFUのプロキシ(/api/sfu/*)
 *    - App Secretはこの Worker のsecretに置き、ブラウザへは出さない
 *    - パブリッシャー(ブリッジ)のセッションIDはKVで共有する。
 *      登録はBRIDGE_TOKENによるBearer認証必須(配信の乗っ取り防止)
 *    - これによりブリッジのトンネル公開が不要になる(共有リンクが固定化)
 * 4. ルーム(同時に複数の配信を成立させる単位)。SFUのパブリッシャー・同接・
 *    コメントはすべてルームごとに分かれる。ルーム名は ?room= で受け取る
 *
 * 「誰が何をしてよいか」の判定はこのファイルには無い。すべて auth.ts の
 * `authorize()` に集約してあるので、独自の会員認証を載せる場合はそちらを差し替える。
 */
import { DurableObject } from 'cloudflare:workers';
import {
  authorize,
  issueAdmission,
  resolveShortLink,
  verifyAdmission,
  type AuthEnv,
  type AuthScope,
} from './auth';

interface Env extends AuthEnv {
  ASSETS: Fetcher;
  VRM_BUCKET: R2Bucket;
  SFU_STATE: KVNamespace;
  PRESENCE: DurableObjectNamespace;
  CF_REALTIME_APP_ID?: string;
  CF_REALTIME_APP_SECRET?: string;
  /** /watch で使う既定VRMのR2キー(wrangler.jsoncのvars) */
  DEFAULT_VRM_KEY?: string;
}

const API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
const DATA_CHANNEL_NAME = 'pose';
/** ブリッジのハートビート(5分間隔)がこの時間途絶えたらパブリッシャー不在とみなす */
const PUBLISHER_FRESH_MS = 15 * 60 * 1000;

// Workerのモジュールexportはハンドラ/Durable Objectクラスのみ許されるため定数はexportしない
const DEFAULT_ROOM = 'main';
/**
 * ルーム名はDurable Objectの名前・KVキーの一部になるため文字種を制限する。
 * ビューア側(src/config.ts)にも同じ規則がある
 */
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

function normalizeRoom(value: string | null | undefined): string {
  const room = (value ?? '').trim();
  return ROOM_PATTERN.test(room) ? room : DEFAULT_ROOM;
}

/** ルームごとのKVキー(旧デプロイのキーとは別空間になるが、失効待ちで問題ない) */
function publisherKey(room: string): string {
  return `publisher:${room}`;
}

function audioPublisherKey(room: string): string {
  return `audio-publisher:${room}`;
}

/**
 * アップロードVRMのサイズ上限。Workersのリクエストボディ上限(100MB)より
 * 手前で弾いて、分かりやすいエラーを返す
 */
const MAX_VRM_BYTES = 80 * 1024 * 1024;

/** ルームにアップロードしたVRMのR2キー接頭辞(既定VRMはトップレベルのまま) */
function roomVrmPrefix(room: string): string {
  return `rooms/${room}/`;
}

/**
 * アップロードされたファイル名の検証。日本語名は許すが、パス区切り・
 * 相対参照・制御文字は弾く(R2キーに直接使うため)
 */
function sanitizeVrmName(raw: string): string | null {
  const base = (raw.split(/[\\/]/).pop() ?? '').trim();
  if (!base || base.length > 100) return null;
  if (base.startsWith('.') || base.includes('..')) return null;
  if (/[\u0000-\u001f\u007f]/.test(base)) return null;
  if (!base.toLowerCase().endsWith('.vrm')) return null;
  return base;
}

/** R2キーを /vrm/ 配信URLに変換する(パス区切りは保ったままエンコード) */
function vrmUrlFor(key: string, token: string): string {
  const path = key.split('/').map(encodeURIComponent).join('/');
  return `/vrm/${path}?k=${encodeURIComponent(token)}`;
}

/** 短縮URLの解決に渡すルーム名の規則(auth.tsは文字種を知らない) */
const SHORT_LINK_OPTIONS = { defaultRoom: DEFAULT_ROOM, normalizeRoom };

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

interface AudioPublisherRecord {
  sessionId: string;
  trackName: string;
  updatedAt: number;
}

async function readPublisher(env: Env, room: string): Promise<PublisherRecord | null> {
  const record = await env.SFU_STATE.get<PublisherRecord>(publisherKey(room), 'json');
  if (!record || Date.now() - record.updatedAt > PUBLISHER_FRESH_MS) return null;
  return record;
}

async function readAudioPublisher(env: Env, room: string): Promise<AudioPublisherRecord | null> {
  const record = await env.SFU_STATE.get<AudioPublisherRecord>(audioPublisherKey(room), 'json');
  if (!record || Date.now() - record.updatedAt > PUBLISHER_FRESH_MS) return null;
  return record;
}

/**
 * 認可の判定は auth.ts の `authorize()` に委譲する。
 * 利用者IDまで要る場所(presence)だけは `authorize()` を直接呼ぶ
 */
async function allows(
  env: Env,
  request: Request,
  url: URL,
  scope: AuthScope,
  room: string,
): Promise<boolean> {
  return (await authorize(env, request, url, { scope, room })).ok;
}

/**
 * 視聴の認可。ルーム設定(公開/招待制)を見たうえで判定する。
 * 設定はKVの写しから読む(認可のたびにDurable Objectを起こさないため)。
 * 設定が無いルームは REQUIRE_VIEWER_TOKEN の既定に落ちる
 */
async function authorizeViewer(env: Env, request: Request, url: URL, room: string) {
  const guard = await readRoomGuard(env, room);
  return authorize(env, request, url, {
    scope: 'viewer',
    room,
    requireViewerToken: guard.access === undefined ? undefined : guard.access === 'invite',
  });
}

/** 視聴できない理由。視聴側はこれを見て表示を出し分け、復帰も待つ */
type Unavailable = 'full' | 'stopped';

const UNAVAILABLE_TEXT: Record<Unavailable, string> = {
  full: '満員です(同時に見られる人数の上限に達しています)',
  stopped: '配信は一時停止中です',
};

/**
 * いま視聴できるか。配信者は対象外(自分の配信を確認できなくなるため)。
 * presenceだけでなくSFUの購読も止めないと、映像と音声は見られたままになり
 * 課金の歯止めにならない
 */
async function viewingBlockedBy(
  env: Env,
  request: Request,
  url: URL,
  room: string,
): Promise<Unavailable | null> {
  const guard = await readRoomGuard(env, room);
  const reason: Unavailable | null = guard.stopped ? 'stopped' : guard.full ? 'full' : null;
  if (!reason) return null;
  // 配信者は自分の配信を確認できる必要がある
  if (await allows(env, request, url, 'broadcaster', room)) return null;
  /**
   * 入室済みの人は満員でも通す。人数の判定は入室のときに済んでいるので、
   * ここで断ると**入室した本人が自分で作った満員に締め出される**。
   * 停止中は配信者の意思なので入室証があっても止める
   */
  if (reason === 'full' && (await verifyAdmission(env, room, url.searchParams.get('adm')))) {
    return null;
  }
  return reason;
}

/**
 * 音声パブリッシャーの登録/解除(bodyのsessionIdがnullなら解除)。
 * KVに保存したうえでPresence DOへ渡し、接続中の視聴者へ即座に配る。
 * KVは途中入室者の状態APIのため、DOは押し出しのために保つ
 */
async function handleAudioPublisherUpdate(request: Request, env: Env, room: string): Promise<Response> {
  const body = (await request.json()) as { sessionId?: string | null; trackName?: string };
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName(room));
  if (!body.sessionId) {
    await env.SFU_STATE.delete(audioPublisherKey(room));
    await stub.fetch('https://presence.internal/audio', { method: 'POST', body: 'null' });
    return json(200, { ok: true, cleared: true });
  }
  const record: AudioPublisherRecord = {
    sessionId: String(body.sessionId),
    trackName: String(body.trackName ?? 'mic'),
    updatedAt: Date.now(),
  };
  await env.SFU_STATE.put(audioPublisherKey(room), JSON.stringify(record));
  await stub.fetch('https://presence.internal/audio', {
    method: 'POST',
    body: JSON.stringify(record),
  });
  return json(200, { ok: true });
}

async function handleSfuApi(request: Request, env: Env, url: URL): Promise<Response> {
  const sfuConfigured = Boolean(env.CF_REALTIME_APP_ID && env.CF_REALTIME_APP_SECRET);
  const room = normalizeRoom(url.searchParams.get('room'));

  /**
   * パブリッシャー登録系はブリッジトークン/配信者キーで別途認可するため除外し、
   * それ以外(＝視聴側が叩く経路)は視聴認可を通す。
   * presenceだけ塞いでもここが空いていればモーションと音声は取れてしまう
   */
  const publisherEndpoint =
    url.pathname === '/api/sfu/publisher' ||
    url.pathname === '/api/sfu/audio-publisher' ||
    url.pathname === '/api/sfu/audio-publisher-beacon';
  const statusEndpoint = url.pathname === '/api/sfu/status';
  if (!publisherEndpoint) {
    if (!(await authorizeViewer(env, request, url, room)).ok) {
      return json(403, { error: 'forbidden(視聴トークンが必要です)' });
    }
    /**
     * 状態APIだけは満員でも停止中でも答える。**理由を知り、復帰を待つための
     * 唯一の窓口**なので、ここを塞ぐと視聴側は何も分からないまま
     * 重いセッション作成を再試行し続けることになる(KV読みだけなので安い)
     */
    if (!statusEndpoint) {
      const blocked = await viewingBlockedBy(env, request, url, room);
      if (blocked) return json(503, { error: UNAVAILABLE_TEXT[blocked] });
    }
  }

  if (request.method === 'GET' && url.pathname === '/api/sfu/status') {
    const audio = await readAudioPublisher(env, room);
    const publisher = await readPublisher(env, room);
    const blocked = await viewingBlockedBy(env, request, url, room);
    return json(200, {
      enabled: sfuConfigured,
      room,
      /** 満員・停止中の理由。視聴側はこれを見て表示を出し分け、解除を待つ */
      unavailable: blocked,
      publisherReady: publisher !== null,
      /**
       * 視聴側が「配信元が変わったか」を判定するために返す。
       * これが無いと、モーションが来ないだけの状態と配信元の再起動を区別できず、
       * セッションを作り直し続けることになる(Cloudflare APIへの発信が跳ね上がる)。
       * 購読には元々このIDが使われるので、視聴者に対して新たな権限にはならない
       */
      publisherSessionId: publisher?.sessionId ?? null,
      audio: audio ? { sessionId: audio.sessionId, trackName: audio.trackName } : null,
    });
  }

  // 音声パブリッシャーの登録/解除(配信者コンソールから。要配信者キー)
  if (
    request.method === 'POST' &&
    (url.pathname === '/api/sfu/audio-publisher' || url.pathname === '/api/sfu/audio-publisher-beacon')
  ) {
    if (!(await allows(env, request, url, 'broadcaster', room))) return json(403, { error: 'forbidden' });
    return handleAudioPublisherUpdate(request, env, room);
  }

  /**
   * DataChannelの作成。
   * location:'local' はポーズの配信そのものなので配信者キーが要る
   * (HMDから直接配信する場合にブラウザから使う)。
   * location:'remote' は視聴側の購読なので誰でも可
   */
  if (request.method === 'POST' && url.pathname === '/api/sfu/datachannels/new') {
    const body = (await request.json()) as {
      sessionId?: string;
      dataChannels?: { location?: string; dataChannelName?: string; sessionId?: string }[];
    };
    if (!body.sessionId || !Array.isArray(body.dataChannels)) {
      return json(400, { error: 'sessionId / dataChannels がありません' });
    }
    const publishesLocal = body.dataChannels.some((c) => c.location === 'local');
    if (publishesLocal && !(await allows(env, request, url, 'broadcaster', room))) {
      return json(403, { error: 'forbidden(配信には配信者キーが必要です)' });
    }
    const result = await cfApi(env, `/sessions/${String(body.sessionId)}/datachannels/new`, {
      dataChannels: body.dataChannels,
    });
    return json(200, result);
  }

  // パブリッシャーのセッションID登録。ブリッジ(BRIDGE_TOKEN)か配信者(BROADCAST_KEY)
  if (request.method === 'POST' && url.pathname === '/api/sfu/publisher') {
    if (!(await allows(env, request, url, 'publisher', room))) {
      return json(403, { error: 'forbidden' });
    }
    const body = (await request.json()) as { sessionId?: string };
    if (!body.sessionId) return json(400, { error: 'sessionIdがありません' });
    const record: PublisherRecord = { sessionId: body.sessionId, updatedAt: Date.now() };
    await env.SFU_STATE.put(publisherKey(room), JSON.stringify(record));
    return json(200, { ok: true, room });
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
    if (publishesLocal && !(await allows(env, request, url, 'broadcaster', room))) {
      return json(403, { error: 'forbidden(トラック公開には配信者キーが必要です)' });
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
    const publisher = await readPublisher(env, room);
    if (!publisher) {
      return json(503, {
        error: `パブリッシャーが未登録です(ルーム「${room}」のブリッジが起動しているか確認)`,
      });
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
    // publisherSessionId は視聴側が「いまどの配信元を購読しているか」を覚えるために返す
    return json(200, {
      id: channelId,
      name: DATA_CHANNEL_NAME,
      publisherSessionId: publisher.sessionId,
    });
  }

  return json(404, { error: 'not found' });
}

interface AvatarRecord {
  /** R2キー */
  key: string;
  /** 表示名(ファイル名) */
  name: string;
  /** 視聴ページがそのままロードできるURL(配信トークン入り) */
  url: string;
  ts: number;
}

/**
 * ルームのVRM管理API(すべて配信者キーが必要)。
 * - POST /api/vrm/upload?room=&name= : R2へアップロード(ボディがVRM本体)
 * - GET  /api/vrm/list?room=         : そのルームにあるVRM一覧
 * - POST /api/vrm/delete?room=&name= : 削除
 */
async function handleVrmApi(request: Request, env: Env, url: URL): Promise<Response> {
  const room = normalizeRoom(url.searchParams.get('room'));
  if (!(await allows(env, request, url, 'broadcaster', room))) {
    return json(403, { error: 'forbidden(配信者キーが必要です)' });
  }
  const prefix = roomVrmPrefix(room);

  if (request.method === 'POST' && url.pathname === '/api/vrm/upload') {
    const name = sanitizeVrmName(url.searchParams.get('name') ?? '');
    if (!name) return json(400, { error: 'ファイル名が不正です(.vrm・100文字以内)' });
    // R2へストリームで渡すには長さが確定している必要がある
    const declared = Number(request.headers.get('Content-Length') ?? '');
    if (!Number.isFinite(declared) || declared <= 0) {
      return json(411, { error: 'Content-Lengthが必要です' });
    }
    if (declared > MAX_VRM_BYTES) {
      const limit = Math.floor(MAX_VRM_BYTES / 1024 / 1024);
      return json(413, { error: `ファイルが大きすぎます(上限 ${limit}MB)` });
    }
    if (!request.body) return json(400, { error: 'ボディがありません' });
    const key = `${prefix}${name}`;
    await env.VRM_BUCKET.put(key, request.body);
    return json(200, { ok: true, key, name, size: declared });
  }

  if (request.method === 'GET' && url.pathname === '/api/vrm/list') {
    const listed = await env.VRM_BUCKET.list({ prefix });
    const items = listed.objects.map((object) => ({
      key: object.key,
      name: object.key.slice(prefix.length),
      size: object.size,
      uploaded: object.uploaded.getTime(),
    }));
    return json(200, { room, items, defaultKey: env.DEFAULT_VRM_KEY ?? null });
  }

  if (request.method === 'POST' && url.pathname === '/api/vrm/delete') {
    const name = sanitizeVrmName(url.searchParams.get('name') ?? '');
    if (!name) return json(400, { error: 'ファイル名が不正です' });
    await env.VRM_BUCKET.delete(`${prefix}${name}`);
    return json(200, { ok: true });
  }

  return json(404, { error: 'not found' });
}

/**
 * 現在のアバターの切り替え(配信者キー必須)。
 * Presence DOへ渡し、接続中の視聴者全員へ即時ブロードキャストしたうえで
 * 保存する(あとから入室した視聴者にも同じアバターが配られる)。
 */
async function handleAvatarApi(request: Request, env: Env, url: URL): Promise<Response> {
  const room = normalizeRoom(url.searchParams.get('room'));
  if (!(await allows(env, request, url, 'broadcaster', room))) {
    return json(403, { error: 'forbidden(配信者キーが必要です)' });
  }

  // 現在のアバター(配信者コンソールが起動時に読む)
  if (request.method === 'GET') {
    const stub = env.PRESENCE.get(env.PRESENCE.idFromName(room));
    const current = await stub.fetch('https://presence.internal/avatar');
    return json(200, (await current.json()) as unknown);
  }

  if (request.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (!env.VRM_TOKEN) {
    return json(503, { error: 'VRM_TOKEN未設定のため配信URLを組み立てられません' });
  }

  const body = (await request.json()) as { key?: string };
  const key = String(body.key ?? '');
  const prefix = roomVrmPrefix(room);
  const localName = key.startsWith(prefix) ? key.slice(prefix.length) : null;
  // 自ルームにアップロードしたVRMか、共有の既定VRMだけを許可する
  const allowed =
    (localName !== null && sanitizeVrmName(localName) === localName) ||
    (Boolean(env.DEFAULT_VRM_KEY) && key === env.DEFAULT_VRM_KEY);
  if (!allowed) return json(400, { error: 'このルームでは使えないキーです' });
  if (!(await env.VRM_BUCKET.head(key))) {
    return json(404, { error: 'R2にそのVRMがありません' });
  }

  const record: AvatarRecord = {
    key,
    name: key.slice(key.lastIndexOf('/') + 1),
    url: vrmUrlFor(key, env.VRM_TOKEN),
    ts: Date.now(),
  };
  const stub = env.PRESENCE.get(env.PRESENCE.idFromName(room));
  const result = await stub.fetch('https://presence.internal/avatar', {
    method: 'POST',
    body: JSON.stringify(record),
  });
  if (!result.ok) return json(502, { error: 'アバターの配信に失敗しました' });
  return json(200, { ok: true, ...record });
}

interface ChatItem {
  text: string;
  ts: number;
}

const CHAT_HISTORY_KEY = 'chat-history';
const CHAT_HISTORY_MAX = 50;
const CHAT_TEXT_MAX = 200;
const CHAT_MIN_INTERVAL_MS = 1000;
/** 視聴者の気配(位置)の最短送信間隔。クライアントは10Hz送信なので余裕を持たせる */
const PEER_MIN_INTERVAL_MS = 60;
/** WebSocketで受け付ける1メッセージの上限(位置データでも数百バイト) */
const MESSAGE_MAX_BYTES = 2048;
/** 現在のアバター(接続時に配り、切り替え時にブロードキャストする) */
const AVATAR_KEY = 'avatar';
/**
 * 現在の音声パブリッシャー。アバターと同じく接続時に配り、変化時に配信する。
 * 以前は視聴側が30秒ごとに状態APIを叩いて確認していたが、視聴者×1日2,880回に
 * なるため押し出しに変えた。応答も速くなる(配信者がマイクを入れた瞬間に届く)
 */
const AUDIO_KEY = 'audio';
/** 視聴者の気配の公開範囲 */
const PEER_MODE_KEY = 'peer-mode';
/**
 * - all: 視聴者どうしもお互いが見える(少人数のミーティング向け)
 * - broadcaster: 配信者だけに見せる。中継がN×1になるので大人数でも耐えられる
 * - off: 送受信しない
 */
type PeerMode = 'all' | 'broadcaster' | 'off';
const DEFAULT_PEER_MODE: PeerMode = 'all';

/** ルーム設定の保存キー(Durable Object内) */
const SETTINGS_KEY = 'settings';
/**
 * 自分のルーム名(Durable Object内)。
 * idFromName で作ったDOは自分の名前を知れないが、KVへ写しを書くのに要るため、
 * 最初に受け取ったリクエストから覚えておく
 */
const ROOM_NAME_KEY = 'room-name';

/**
 * ルームごとの設定。**公開配信・非公開配信・イベント会場を別物として作らず、
 * ここの切り替えだけで賄う**のが方針(docs/アーキテクチャ.md)。
 * 配信者コンソールから実行時に変更でき、デプロイし直す必要はない。
 */
interface RoomSettings {
  /** public: 誰でも視聴できる / invite: 視聴トークンが要る */
  access: 'public' | 'invite';
  /** 匿名コメントの可否 */
  chat: boolean;
  /** 同時接続の上限(null で無制限)。URLが出回ったときの課金の歯止め */
  capacity: number | null;
  /**
   * 緊急停止。立てると新規の視聴を断り、視聴中のクライアントへも停止を伝える。
   * **既に流れている購読をサーバーから切ることはできない**(視聴者のSFU
   * セッションを追跡していないため)。止まるのは新規の受け入れと、
   * 停止を受け取ったクライアントの自発的な切断
   */
  stopped: boolean;
  /** 視聴者の気配の公開範囲 */
  peerMode: PeerMode;
  /**
   * 視聴者の発話(プッシュトゥトーク)。**まだ未実装なので常に false。**
   * 設定の枠だけ先に用意しておき、実装時はここを立てるだけで済むようにする
   */
  viewerVoice: boolean;
}

/** 上限の上限。設定ミスで青天井にならないよう、受け付ける値自体を制限する */
const MAX_CAPACITY = 10000;

function defaultSettings(env: Env): RoomSettings {
  return {
    // 従来の環境変数は「設定を持たないルームの既定値」として残す
    access: env.REQUIRE_VIEWER_TOKEN === '1' ? 'invite' : 'public',
    chat: true,
    capacity: null,
    stopped: false,
    peerMode: DEFAULT_PEER_MODE,
    viewerVoice: false,
  };
}

/** 受け取った値を検証して設定へ畳み込む(未知のキーと不正な値は無視する) */
function mergeSettings(current: RoomSettings, patch: Record<string, unknown>): RoomSettings {
  const next: RoomSettings = { ...current };
  if (patch.access === 'public' || patch.access === 'invite') next.access = patch.access;
  if (typeof patch.chat === 'boolean') next.chat = patch.chat;
  if (patch.capacity === null) next.capacity = null;
  else if (typeof patch.capacity === 'number' && Number.isFinite(patch.capacity)) {
    next.capacity = Math.max(1, Math.min(MAX_CAPACITY, Math.floor(patch.capacity)));
  }
  if (patch.peerMode === 'all' || patch.peerMode === 'broadcaster' || patch.peerMode === 'off') {
    next.peerMode = patch.peerMode;
  }
  if (typeof patch.stopped === 'boolean') next.stopped = patch.stopped;
  if (typeof patch.viewerVoice === 'boolean') next.viewerVoice = patch.viewerVoice;
  return next;
}

/**
 * Worker本体が視聴の認可時に読む、ルーム設定の写し。
 * 認可のたびにDurable Objectを起こすのは高くつくため、KVに写しておく
 * (真の値はDO側。KVは読み取り専用の索引として扱う)
 */
function settingsKey(room: string): string {
  return `settings:${room}`;
}

/** KVに写している内容。認可のたびにDurable Objectを起こさないための索引 */
interface RoomGuard {
  access?: 'public' | 'invite';
  /**
   * 満員かどうか。**課金されるのはSFUのエグレス**なので、presenceだけ塞いでも
   * 歯止めにならない。SFUの購読を止めるにはWorker側で判定する必要があり、
   * その値をDOがここへ写している(切り替わったときだけ書くのでKVの書き込みは増えない)
   */
  full?: boolean;
  /** 緊急停止中か */
  stopped?: boolean;
}

async function readRoomGuard(env: Env, room: string): Promise<RoomGuard> {
  return (await env.SFU_STATE.get<RoomGuard>(settingsKey(room), 'json')) ?? {};
}

/**
 * 同接カウント+匿名コメント用のDurable Object(ルームごとに1インスタンス)。
 * 視聴ページがWebSocketで接続し、
 * - 同接: 開いているソケット数を増減のたびに全員へ配信
 * - コメント: 受信を検証(長さ・1秒レート制限)して全員へ配信。
 *   直近50件はストレージに保存し、接続時に履歴として送る
 * ハイバネーションAPIを使うので接続が張りっぱなしでもアイドルコストはほぼゼロ。
 */
export class Presence extends DurableObject<Env> {
  /** 視聴者の気配メッセージのレート制限(接続ID → 最終受信時刻) */
  private readonly lastPeerAt = new Map<string, number>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // クライアントの生存確認ping/pongはDOを起こさずランタイムが自動応答する
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  override async fetch(request: Request): Promise<Response> {
    const requestUrl = new URL(request.url);
    const path = requestUrl.pathname;
    // KVへ写しを書くのに自分のルーム名が要る。Worker本体が付けてくる
    const roomParam = requestUrl.searchParams.get('room');
    if (roomParam && (await this.ctx.storage.get<string>(ROOM_NAME_KEY)) !== roomParam) {
      await this.ctx.storage.put(ROOM_NAME_KEY, roomParam);
    }

    // ルーム設定(Worker本体が配信者キーを検証したうえで呼ぶ内部API)
    if (path === '/settings') {
      if (request.method === 'POST') {
        const patch = (await request.json()) as Record<string, unknown>;
        const settings = await this.applySettings(patch);
        return Response.json({ settings });
      }
      return Response.json({ settings: await this.settings() });
    }

    // 視聴者の気配の公開範囲。ルーム設定へ統合したので、こちらは旧APIの別名
    if (path === '/peer-mode') {
      if (request.method === 'POST') {
        const body = (await request.json()) as { mode?: string };
        const settings = await this.applySettings({ peerMode: body.mode });
        return Response.json({ ok: true, mode: settings.peerMode });
      }
      return Response.json({ mode: (await this.settings()).peerMode });
    }

    // アバターの取得/切り替え(Worker本体が配信者キーを検証したうえで呼ぶ内部API)
    if (path === '/avatar') {
      if (request.method === 'GET') {
        const current = (await this.ctx.storage.get<AvatarRecord>(AVATAR_KEY)) ?? null;
        return Response.json({ avatar: current });
      }
      const record = (await request.json()) as AvatarRecord;
      await this.ctx.storage.put(AVATAR_KEY, record);
      this.broadcastJson({ type: 'avatar', ...record });
      return new Response(null, { status: 204 });
    }

    /**
     * 音声パブリッシャーの更新(Worker本体が配信者キーを検証したうえで呼ぶ内部API)。
     * 変化があったときだけ配る。配信者は4分ごとにハートビートを送ってくるので、
     * 毎回配ると無意味な再購読を誘発する
     */
    if (path === '/audio') {
      const next = (await request.json()) as AudioPublisherRecord | null;
      const current = (await this.ctx.storage.get<AudioPublisherRecord>(AUDIO_KEY)) ?? null;
      if (!next) {
        if (current) {
          await this.ctx.storage.delete(AUDIO_KEY);
          this.broadcastJson({ type: 'audio', audio: null });
        }
        return new Response(null, { status: 204 });
      }
      await this.ctx.storage.put(AUDIO_KEY, next);
      // 登録が途絶えたまま配信者が落ちた場合に備え、失効時刻に自分で気づく
      await this.ctx.storage.setAlarm(next.updatedAt + PUBLISHER_FRESH_MS);
      if (current?.sessionId !== next.sessionId || current?.trackName !== next.trackName) {
        this.broadcastJson({ type: 'audio', audio: { sessionId: next.sessionId, trackName: next.trackName } });
      }
      return new Response(null, { status: 204 });
    }

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('expected websocket', { status: 426 });
    }

    const settings = await this.settings();
    const isBroadcaster = new URL(request.url).searchParams.get('broadcaster') === '1';
    // 同時接続の上限。配信者は数えないし、締め出しもしない
    if (
      !isBroadcaster &&
      settings.capacity !== null &&
      this.viewerCount() >= settings.capacity
    ) {
      return new Response('room is full', { status: 503 });
    }

    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    // 視聴者の気配(位置の中継)に使う接続ごとのIDと役割、および利用者ID。
    // ハイバネーションから復帰しても残るようattachmentへ入れる。
    // いずれもWorker本体が検証済み(クライアントは書き換えられない)
    const params = new URL(request.url).searchParams;
    pair[1].serializeAttachment({
      id: crypto.randomUUID().slice(0, 8),
      role: isBroadcaster ? 'broadcaster' : 'viewer',
      // 独自認証を入れた場合の利用者ID(既定の鍵方式では常に無い)
      userId: params.get('uid') ?? undefined,
    });
    this.broadcastCount();
    // 満員になったらSFUの購読も断るようKVへ写す
    await this.syncGuard(settings);
    const history = (await this.ctx.storage.get<ChatItem[]>(CHAT_HISTORY_KEY)) ?? [];
    pair[1].send(JSON.stringify({ type: 'history', items: history }));
    pair[1].send(JSON.stringify({ type: 'settings', settings }));
    /**
     * 入室証。ここまで来た＝人数の判定を通ったということなので、
     * 以後のSFUリクエストで「入室済み」を示せるようにする
     */
    const roomName = (await this.ctx.storage.get<string>(ROOM_NAME_KEY)) ?? DEFAULT_ROOM;
    const admission = await issueAdmission(this.env, roomName);
    if (admission) pair[1].send(JSON.stringify({ type: 'admission', token: admission }));
    // 旧クライアント向け(設定メッセージを知らない版でも気配は動く)
    pair[1].send(JSON.stringify({ type: 'peerMode', mode: settings.peerMode }));
    // 途中入室者にも現在のアバターを配る(配信者が切り替えた状態に追いつける)
    const avatar = await this.ctx.storage.get<AvatarRecord>(AVATAR_KEY);
    if (avatar) pair[1].send(JSON.stringify({ type: 'avatar', ...avatar }));
    // 音声も同様。既に配信中なら入室した時点で購読できる
    const audio = await this.freshAudio();
    if (audio) {
      pair[1].send(
        JSON.stringify({ type: 'audio', audio: { sessionId: audio.sessionId, trackName: audio.trackName } }),
      );
    }
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  /** 保存済みの音声パブリッシャー。失効していれば null */
  private async freshAudio(): Promise<AudioPublisherRecord | null> {
    const record = (await this.ctx.storage.get<AudioPublisherRecord>(AUDIO_KEY)) ?? null;
    if (!record || Date.now() - record.updatedAt > PUBLISHER_FRESH_MS) return null;
    return record;
  }

  /**
   * 音声パブリッシャーの失効。
   * 配信者のタブが登録解除を送れずに閉じた場合、これが唯一の終了通知になる
   * (視聴側のポーリングを廃止したため、サーバーから知らせる必要がある)
   */
  override async alarm(): Promise<void> {
    const record = (await this.ctx.storage.get<AudioPublisherRecord>(AUDIO_KEY)) ?? null;
    if (!record) return;
    if (Date.now() - record.updatedAt <= PUBLISHER_FRESH_MS) {
      // ハートビートで更新されていた。次の失効時刻へ繰り延べる
      await this.ctx.storage.setAlarm(record.updatedAt + PUBLISHER_FRESH_MS);
      return;
    }
    await this.ctx.storage.delete(AUDIO_KEY);
    this.broadcastJson({ type: 'audio', audio: null });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;
    if (message.length > MESSAGE_MAX_BYTES) return;
    let data: { type?: string; text?: string };
    try {
      data = JSON.parse(message) as { type?: string; text?: string };
    } catch {
      return;
    }

    // 視聴者の気配: 位置は保存せず、送信者以外へそのまま中継するだけ。
    // 座標はアバター基準の相対値なので、各自の空間が違っても意味が通る
    if (data.type === 'peer') {
      const attachment = (ws.deserializeAttachment() ?? {}) as { id?: string };
      if (!attachment.id) return;
      const mode = (await this.settings()).peerMode;
      if (mode === 'off') return;
      const now = Date.now();
      const last = this.lastPeerAt.get(attachment.id) ?? 0;
      // 濫用防止のレート制限(ハイバネーションで消えても実害がないためメモリ上で持つ)
      if (now - last < PEER_MIN_INTERVAL_MS) return;
      this.lastPeerAt.set(attachment.id, now);
      const payload = { ...data, id: attachment.id };
      // 'broadcaster' は配信者の接続にだけ送る。中継量がN×1で済む
      if (mode === 'broadcaster') this.sendToBroadcasters(payload, ws);
      else this.broadcastJson(payload, ws);
      return;
    }

    if (data.type !== 'chat' || typeof data.text !== 'string') return;
    // コメントを止めているルームでは受け付けない(クライアント側でも入力を塞ぐが、
    // 直接WebSocketへ送られる可能性があるのでサーバーでも弾く)
    if (!(await this.settings()).chat) return;

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

  override async webSocketClose(ws: WebSocket): Promise<void> {
    this.handleLeave(ws);
    // 空きが出たらSFU側の受け入れも再開する
    await this.syncGuard(await this.settings(), ws);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.handleLeave(ws);
    await this.syncGuard(await this.settings(), ws);
  }

  /** 退場時: 同接を配り直し、視聴者の気配を消すよう伝える */
  private handleLeave(ws: WebSocket): void {
    const attachment = (ws.deserializeAttachment() ?? {}) as { id?: string };
    if (attachment.id) {
      this.lastPeerAt.delete(attachment.id);
      this.broadcastJson({ type: 'peerLeft', id: attachment.id }, ws);
    }
    this.broadcastCount(ws);
  }

  private broadcastCount(closing?: WebSocket): void {
    const count = this.ctx.getWebSockets().filter((s) => s !== closing).length;
    // 旧クライアント互換のため count フィールドはトップレベルに残す
    this.broadcastJson({ type: 'count', count }, closing);
  }

  /**
   * 同時接続の上限に数える人数。
   *
   * **配信者コンソールは数えない。** 「同時に見られる人数」は視聴者を指すので、
   * 配信者が枠を1つ占めると上限1のルームが最初から満員になってしまう。
   * 切断処理中のソケットはまだ getWebSockets() に含まれるため除く
   * (数え違えると、空きが出ても満員のままになる)
   */
  private viewerCount(closing?: WebSocket): number {
    return this.ctx.getWebSockets().filter((socket) => {
      if (socket === closing) return false;
      const attachment = (socket.deserializeAttachment() ?? {}) as { role?: string };
      return attachment.role !== 'broadcaster';
    }).length;
  }

  /**
   * ルーム設定。まだ保存されていなければ既定値を組み立てる。
   * 旧方式で保存されていた気配の公開範囲は、ここで引き継ぐ
   * (設定を統合する前に作られたルームでも、設定し直さずに済むように)
   */
  private async settings(): Promise<RoomSettings> {
    const stored = await this.ctx.storage.get<RoomSettings>(SETTINGS_KEY);
    if (stored) return { ...defaultSettings(this.env), ...stored };
    const legacyPeerMode = await this.ctx.storage.get<PeerMode>(PEER_MODE_KEY);
    const base = defaultSettings(this.env);
    return legacyPeerMode ? { ...base, peerMode: legacyPeerMode } : base;
  }

  /**
   * 満員かどうかをKVへ写す。Worker本体はここを見てSFUの購読を断る。
   * **切り替わったときだけ書く**(入退室のたびに書くとKVの書き込み上限に当たる)
   */
  private async syncGuard(settings: RoomSettings, closing?: WebSocket): Promise<void> {
    const full = settings.capacity !== null && this.viewerCount(closing) >= settings.capacity;
    const room = (await this.ctx.storage.get<string>(ROOM_NAME_KEY)) ?? DEFAULT_ROOM;
    const current = await this.env.SFU_STATE.get<RoomGuard>(settingsKey(room), 'json');
    if (
      current?.access === settings.access &&
      Boolean(current?.full) === full &&
      Boolean(current?.stopped) === settings.stopped
    ) {
      return;
    }
    await this.env.SFU_STATE.put(
      settingsKey(room),
      JSON.stringify({
        access: settings.access,
        full,
        stopped: settings.stopped,
      } satisfies RoomGuard),
    );
  }

  /** 設定を更新して保存し、接続中の全員へ配る */
  private async applySettings(patch: Record<string, unknown>): Promise<RoomSettings> {
    const settings = mergeSettings(await this.settings(), patch);
    await this.ctx.storage.put(SETTINGS_KEY, settings);
    await this.syncGuard(settings);
    this.broadcastJson({ type: 'settings', settings });
    // 旧クライアント(設定メッセージを知らない版)のために気配の範囲は個別にも配る
    this.broadcastJson({ type: 'peerMode', mode: settings.peerMode });
    return settings;
  }

  /** 配信者として接続しているソケットにだけ送る */
  private sendToBroadcasters(payload: unknown, sender?: WebSocket): void {
    const message = JSON.stringify(payload);
    for (const socket of this.ctx.getWebSockets()) {
      if (socket === sender) continue;
      const attachment = (socket.deserializeAttachment() ?? {}) as { role?: string };
      if (attachment.role !== 'broadcaster') continue;
      try {
        socket.send(message);
      } catch {
        // 送信失敗はclose側のハンドラに任せる
      }
    }
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

    // 同接カウント+コメント(WebSocket)。ルームごとのDurable Objectへ委譲する。
    // 既定ルームは 'main' なので、ルーム導入前のインスタンス(履歴含む)を引き継ぐ
    if (url.pathname === '/api/presence') {
      const room = normalizeRoom(url.searchParams.get('room'));
      // 視聴者の認可点(会員限定にする場合は auth.ts の authorize を差し替える)
      const viewer = await authorizeViewer(env, request, url, room);
      if (!viewer.ok) return json(403, { error: 'forbidden(視聴トークンが必要です)' });
      /**
       * 配信者かどうかはここで検証してDOへ伝える。
       * クライアントの自己申告を信じると、視聴者の位置を誰でも覗けてしまう
       */
      const broadcaster = await allows(env, request, url, 'broadcaster', room);
      const internal = new URL(request.url);
      internal.searchParams.set('broadcaster', broadcaster ? '1' : '0');
      // 独自認証が利用者IDを返したらDOまで届ける(コメントや視聴ログの紐づけ用)。
      // クライアントの自己申告ではなく、ここで検証済みの値だけを渡す
      internal.searchParams.delete('uid');
      if (viewer.userId) internal.searchParams.set('uid', viewer.userId);
      return env.PRESENCE.get(env.PRESENCE.idFromName(room)).fetch(
        new Request(internal, request),
      );
    }

    /**
     * ルーム設定の取得/変更(配信者のみ)。
     * 変更はDurable Objectを真の値として保存し、視聴の認可で使う項目だけ
     * KVへ写す(認可のたびにDOを起こさないため)
     */
    if (url.pathname === '/api/room-settings') {
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!(await allows(env, request, url, 'broadcaster', room))) {
        return json(403, { error: 'forbidden(配信者キーが必要です)' });
      }
      const stub = env.PRESENCE.get(env.PRESENCE.idFromName(room));
      // ルーム名を渡す(DOはKVへ写しを書くのに自分の名前が要る)
      const result = await stub.fetch(
        new Request(`https://presence.internal/settings?room=${encodeURIComponent(room)}`, {
          method: request.method,
          body: request.method === 'POST' ? await request.text() : undefined,
        }),
      );
      return json(result.status, (await result.json()) as unknown);
    }

    // 視聴者の気配の公開範囲(配信者が切り替える)。ルーム設定へ統合済みの旧API
    if (url.pathname === '/api/peer-mode') {
      const room = normalizeRoom(url.searchParams.get('room'));
      if (!(await allows(env, request, url, 'broadcaster', room))) {
        return json(403, { error: 'forbidden(配信者キーが必要です)' });
      }
      const stub = env.PRESENCE.get(env.PRESENCE.idFromName(room));
      const result = await stub.fetch(
        new Request('https://presence.internal/peer-mode', {
          method: request.method,
          body: request.method === 'POST' ? await request.text() : undefined,
        }),
      );
      return json(result.status, (await result.json()) as unknown);
    }

    // 視聴用の短縮URL: /watch/<ルーム>/<トークン>(または旧形式の /watch/<キー>)を
    // 開くだけで、VRMトークン入りの視聴パラメータ付きURLへリダイレクトする
    // (秘密はすべてWorker側に置く)
    if (url.pathname.startsWith('/watch/')) {
      const resolved = await resolveShortLink(env, 'watch', url.pathname, '/watch/', SHORT_LINK_OPTIONS);
      if (!resolved) return new Response('not found', { status: 404 });
      const vrmKey = env.DEFAULT_VRM_KEY ?? 'avatar.vrm';
      const vrmParam = encodeURIComponent(`/vrm/${vrmKey}?k=${env.VRM_TOKEN ?? ''}`);
      const roomParam = encodeURIComponent(resolved.room);
      // 視聴トークンをビューアへ引き継ぐ(REQUIRE_VIEWER_TOKEN時にAPIの認可で使う)。
      // 既定では検証されないので、従来の視聴URLとの互換は保たれる
      const watchParam = encodeURIComponent(resolved.key);
      return Response.redirect(
        `${url.origin}/?vrm=${vrmParam}&transport=sfu&watch=1&room=${roomParam}&wt=${watchParam}`,
        302,
      );
    }

    // 配信者コンソール(音声)の短縮URL
    if (url.pathname.startsWith('/broadcast/')) {
      const resolved = await resolveShortLink(
        env,
        'broadcast',
        url.pathname,
        '/broadcast/',
        SHORT_LINK_OPTIONS,
      );
      if (!resolved) return new Response('not found', { status: 404 });
      const keyParam = encodeURIComponent(resolved.key);
      const roomParam = encodeURIComponent(resolved.room);
      return Response.redirect(
        `${url.origin}/broadcast.html?key=${keyParam}&room=${roomParam}`,
        302,
      );
    }

    if (
      url.pathname.startsWith('/api/sfu/') ||
      url.pathname.startsWith('/api/vrm/') ||
      url.pathname === '/api/avatar'
    ) {
      if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
      }
      try {
        if (url.pathname.startsWith('/api/vrm/')) return await handleVrmApi(request, env, url);
        if (url.pathname === '/api/avatar') return await handleAvatarApi(request, env, url);
        return await handleSfuApi(request, env, url);
      } catch (error) {
        return json(500, { error: String(error) });
      }
    }

    if (url.pathname.startsWith('/vrm/')) {
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
      }
      // VRM本体の取得も認可点を通す(署名付きURLに変えるならauth.ts側だけで済む)
      if (!(await allows(env, request, url, 'vrm', DEFAULT_ROOM))) {
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
