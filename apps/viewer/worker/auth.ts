/**
 * Worker側の認可。**「誰が何をしてよいか」を決める唯一の場所。**
 *
 * 独自の会員認証(IdPのJWT検証、セッションCookie、自前のユーザーDB等)を載せる
 * 場合は、このファイルの `authorize()` だけを差し替えれば足りるようにしてある。
 * ルーティングやSFUの中継処理(index.ts)には秘密の比較を一切残していない。
 *
 * 既定の実装は「URLに載せた鍵を照合する」方式:
 * - 配信者 : BROADCAST_KEY(全ルーム共通のマスターキー)または
 *            HMAC(ROOM_SECRET, "broadcast:<ルーム>")
 * - 視聴者 : 既定は無条件で許可(匿名視聴)。REQUIRE_VIEWER_TOKEN='1' のときだけ
 *            WATCH_KEY または HMAC(ROOM_SECRET, "watch:<ルーム>")を要求する
 * - ブリッジ: BRIDGE_TOKEN(配信者キーでも代替できる)
 * - VRM配信 : VRM_TOKEN
 *
 * クライアント側の対になる差し替え点は src/auth.ts の `createAuth()`。
 */

/** 認可に関わる環境変数だけを切り出したもの(index.ts の Env はこれを継承する) */
export interface AuthEnv {
  /** R2のVRM配信の照合トークン */
  VRM_TOKEN?: string;
  /** ブリッジのパブリッシャー登録用 */
  BRIDGE_TOKEN?: string;
  /** 視聴用の短縮パス /watch/<キー> の照合キー。既定ルーム専用の旧方式 */
  WATCH_KEY?: string;
  /** 配信者コンソール /broadcast/<キー> の照合キー。全ルームのマスターキーも兼ねる */
  BROADCAST_KEY?: string;
  /**
   * ルームごとの視聴/配信トークンを導出するマスターシークレット。
   * これを設定すると /watch/<ルーム>/<トークン> 形式で無制限にルームを作れる
   * (ルーム一覧をサーバーに持たずに済む)。scripts/roomLink.mjs でURLを生成する
   */
  ROOM_SECRET?: string;
  /**
   * '1' で視聴にもトークンを要求する。
   * 既定(未設定)はルーム名を知っていれば誰でも視聴できる匿名視聴
   */
  REQUIRE_VIEWER_TOKEN?: string;
}

/**
 * 認可を求める操作の種別。
 * - viewer     : 視聴(ポーズ・音声の購読、同接・コメント)
 * - broadcaster: 配信の操作(トラック公開、アバターの切り替え・アップロード、公開範囲)
 * - publisher  : パブリッシャーのセッション登録(ブリッジまたは配信者)
 * - vrm        : R2のVRM本体の取得
 */
export type AuthScope = 'viewer' | 'broadcaster' | 'publisher' | 'vrm';

export interface AuthResult {
  ok: boolean;
  /**
   * 利用者の識別子。既定の鍵方式は「鍵を持っているか」しか見ないので常に undefined。
   * 独自の会員認証を入れた場合はここに利用者IDを載せると、Presence Durable Object
   * まで届く(接続ごとのattachmentに入る)ので、コメントや視聴ログを
   * アカウントに紐づけられる
   */
  userId?: string;
}

const OK: AuthResult = { ok: true };
const DENIED: AuthResult = { ok: false };

const TOKEN_LENGTH = 22;
const textEncoder = new TextEncoder();

function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * ルームトークンの導出: HMAC-SHA256(ROOM_SECRET, "<用途>:<ルーム>")。
 * ルーム一覧をサーバーに保存せずに、ルームごとに異なる鍵を配れる
 */
async function roomToken(secret: string, scope: 'watch' | 'broadcast', room: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(`${scope}:${room}`));
  return base64url(new Uint8Array(signature)).slice(0, TOKEN_LENGTH);
}

/** 秘密の比較は文字列長・内容ともに早期リターンしない */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function matchesRoomToken(
  env: AuthEnv,
  scope: 'watch' | 'broadcast',
  room: string,
  candidate: string,
): Promise<boolean> {
  if (!env.ROOM_SECRET || !candidate) return false;
  return timingSafeEqual(await roomToken(env.ROOM_SECRET, scope, room), candidate);
}

/**
 * リクエストから資格情報を取り出す。
 * ヘッダを優先し、無ければクエリを見る。**クエリを受けるのは必須**で、
 * ブラウザのWebSocket(presence)とsendBeaconは `Authorization` を付けられないため。
 * クエリ名は用途ごとに分けてある(key=配信者 / wt=視聴 / k=VRM)
 */
function readCredential(request: Request, url: URL, queryNames: string[]): string {
  const header = request.headers.get('Authorization') ?? '';
  if (header.startsWith('Bearer ')) return header.slice('Bearer '.length);
  for (const name of queryNames) {
    const value = url.searchParams.get(name);
    if (value) return value;
  }
  return '';
}

async function isBroadcaster(env: AuthEnv, request: Request, url: URL, room: string): Promise<boolean> {
  const candidate = readCredential(request, url, ['key']);
  if (!candidate) return false;
  if (env.BROADCAST_KEY && timingSafeEqual(env.BROADCAST_KEY, candidate)) return true;
  return matchesRoomToken(env, 'broadcast', room, candidate);
}

/**
 * 認可の判定。差し替えるならこの関数。
 * `request` と `room` が渡るので、Cookieの検証でもJWTの検証でも判断材料は足りる。
 */
export async function authorize(
  env: AuthEnv,
  request: Request,
  url: URL,
  ctx: {
    scope: AuthScope;
    room: string;
    /**
     * 視聴にトークンを要求するか。ルームごとの設定で実行時に切り替えるため、
     * 呼び出し側が解決して渡す。省略時は REQUIRE_VIEWER_TOKEN を既定として使う
     * (設定を持たない従来のルームはこちらに落ちる)
     */
    requireViewerToken?: boolean;
  },
): Promise<AuthResult> {
  const { scope, room } = ctx;

  if (scope === 'vrm') {
    // トークン未設定時は配信自体を無効にする(安全側)
    if (!env.VRM_TOKEN) return DENIED;
    const candidate = readCredential(request, url, ['k']);
    return timingSafeEqual(env.VRM_TOKEN, candidate) ? OK : DENIED;
  }

  if (scope === 'publisher') {
    const header = request.headers.get('Authorization') ?? '';
    if (env.BRIDGE_TOKEN && header === `Bearer ${env.BRIDGE_TOKEN}`) return OK;
    return (await isBroadcaster(env, request, url, room)) ? OK : DENIED;
  }

  if (scope === 'broadcaster') {
    return (await isBroadcaster(env, request, url, room)) ? OK : DENIED;
  }

  // scope === 'viewer'
  const requireToken = ctx.requireViewerToken ?? env.REQUIRE_VIEWER_TOKEN === '1';
  if (!requireToken) return OK; // 匿名視聴
  // 配信者は当然視聴もできる(配信者コンソールのプレビューがこの経路を通る)
  if (await isBroadcaster(env, request, url, room)) return OK;
  const candidate = readCredential(request, url, ['wt']);
  if (!candidate) return DENIED;
  if (env.WATCH_KEY && timingSafeEqual(env.WATCH_KEY, candidate)) return OK;
  return (await matchesRoomToken(env, 'watch', room, candidate)) ? OK : DENIED;
}

/**
 * 短縮URLのルーム解決。
 * - /<用途>/<ルーム>/<トークン>: ROOM_SECRETから導出したトークンと照合する新形式
 * - /<用途>/<キー>: 既定ルーム専用の旧形式(WATCH_KEY / BROADCAST_KEY)
 * 戻り値の key は、リダイレクト先のURLへ引き継いでAPIの認可に使う
 */
export async function resolveShortLink(
  env: AuthEnv,
  scope: 'watch' | 'broadcast',
  pathname: string,
  prefix: string,
  options: { defaultRoom: string; normalizeRoom: (value: string) => string },
): Promise<{ room: string; key: string } | null> {
  let segments: string[];
  try {
    segments = pathname.slice(prefix.length).split('/').map(decodeURIComponent);
  } catch {
    return null; // 不正なパーセントエンコード
  }
  // 末尾スラッシュを許容する
  if (segments.length > 1 && segments[segments.length - 1] === '') segments.pop();

  if (segments.length === 2) {
    const room = segments[0] ?? '';
    const token = segments[1] ?? '';
    // 正規化で名前が変わるルーム(=文字種違反)はトークンが一致しても拒否する
    if (!token || options.normalizeRoom(room) !== room) return null;
    return (await matchesRoomToken(env, scope, room, token)) ? { room, key: token } : null;
  }

  if (segments.length === 1) {
    const legacy = scope === 'watch' ? env.WATCH_KEY : env.BROADCAST_KEY;
    const key = segments[0] ?? '';
    if (!legacy || !key || !timingSafeEqual(legacy, key)) return null;
    return { room: options.defaultRoom, key };
  }

  return null;
}
