/**
 * 運営者の管理画面のAPI(/api/admin/*、ADMIN_KEY 必須)。
 *
 * - コメント機能の許可(サービス全体で1つ)。**既定は許可しない。**
 *   電気通信事業の届出をしていない運営者が、配信者のうっかりでコメント(=他人の通信の媒介)を
 *   始めてしまわないよう、許可していない間は配信者コンソールからオンにできない
 * - ルームの一覧(配信者・視聴者の数、設定、使っているアバター・ステージ)
 * - ルームにアップロードされたVRM・ステージモデルの一覧と削除
 *
 * ルームの一覧はサーバーが持っていないため、次の3つを合わせて作る:
 * Presence DO が初めて名前を知ったときに書く `room:<ルーム>`(KV)、
 * 配信者の登録の写し `publisher:<ルーム>`(KV)、R2 の `rooms/<ルーム>/` 接頭辞
 */
import { authorize, type AuthEnv } from './auth';

export interface AdminEnv extends AuthEnv {
  VRM_BUCKET: R2Bucket;
  SFU_STATE: KVNamespace;
  PRESENCE: DurableObjectNamespace;
}

/** コメント機能を許可しているか(KV)。'1' のときだけ許可 */
const COMMENTS_POLICY_KEY = 'admin:comments-allowed';
/** ルームの索引(KV)。値は最初に見えた時刻 */
export const ROOM_INDEX_PREFIX = 'room:';
const PUBLISHER_PREFIX = 'publisher:';
const ROOM_FILES_PREFIX = 'rooms/';

export async function commentsAllowed(kv: KVNamespace): Promise<boolean> {
  return (await kv.get(COMMENTS_POLICY_KEY)) === '1';
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

function presence(env: AdminEnv, room: string): DurableObjectStub {
  return env.PRESENCE.get(env.PRESENCE.idFromName(room));
}

/** KVの接頭辞で並ぶキーを、接頭辞を外して全部集める(ページングあり) */
async function listKvNames(kv: KVNamespace, prefix: string): Promise<string[]> {
  const names: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await kv.list({ prefix, cursor });
    for (const key of page.keys) names.push(key.name.slice(prefix.length));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return names;
}

/** R2の rooms/<ルーム>/ からルーム名を集める */
async function listFileRooms(bucket: R2Bucket): Promise<string[]> {
  const rooms: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix: ROOM_FILES_PREFIX, delimiter: '/', cursor });
    for (const prefix of page.delimitedPrefixes) {
      rooms.push(prefix.slice(ROOM_FILES_PREFIX.length, -1));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return rooms;
}

async function knownRooms(env: AdminEnv): Promise<string[]> {
  const [indexed, publishing, withFiles] = await Promise.all([
    listKvNames(env.SFU_STATE, ROOM_INDEX_PREFIX),
    listKvNames(env.SFU_STATE, PUBLISHER_PREFIX),
    listFileRooms(env.VRM_BUCKET),
  ]);
  return [...new Set([...indexed, ...publishing, ...withFiles])].sort();
}

/** ルームファイルのキーとして正しいか(rooms/<ルーム>/... 以外は消させない) */
function isRoomFileKey(key: string): boolean {
  return (
    key.startsWith(ROOM_FILES_PREFIX) &&
    key.split('/').length >= 3 &&
    !key.split('/').some((part) => part === '' || part === '.' || part === '..')
  );
}

export async function handleAdminApi(request: Request, env: AdminEnv, url: URL): Promise<Response> {
  const auth = await authorize(env, request, url, { scope: 'admin', room: '' });
  if (!auth.ok) {
    return json(403, { error: 'forbidden(Cloudflare Access のログインか管理者キーが必要です)' });
  }
  // Accessのログインは Cookie でも通るので、よそのサイトから送らせる書き込み(CSRF)を断る
  if (request.method !== 'GET' && request.headers.get('Origin') !== url.origin) {
    return json(403, { error: 'forbidden(別のサイトからの操作です)' });
  }

  // 全体の状態とルーム一覧
  if (request.method === 'GET' && url.pathname === '/api/admin/overview') {
    const rooms = await knownRooms(env);
    const statuses = await Promise.all(
      rooms.map(async (room) => {
        try {
          const res = await presence(env, room).fetch(
            `https://presence.internal/admin-status?room=${encodeURIComponent(room)}`,
          );
          return { room, ...((await res.json()) as Record<string, unknown>) };
        } catch (error) {
          return { room, error: String(error) };
        }
      }),
    );
    return json(200, {
      commentsAllowed: await commentsAllowed(env.SFU_STATE),
      // Accessでログインしていればそのメールアドレス(管理者キーで入ったときは無い)
      operator: auth.userId ?? null,
      rooms: statuses,
    });
  }

  // コメント機能の許可。接続中の視聴者へもすぐ反映する(禁止したら表示中のコメントも消える)
  if (request.method === 'POST' && url.pathname === '/api/admin/comments') {
    const body = (await request.json()) as { allowed?: unknown };
    if (typeof body.allowed !== 'boolean') return json(400, { error: 'allowed が必要です' });
    if (body.allowed) await env.SFU_STATE.put(COMMENTS_POLICY_KEY, '1');
    else await env.SFU_STATE.delete(COMMENTS_POLICY_KEY);
    const rooms = await knownRooms(env);
    await Promise.all(
      rooms.map((room) =>
        presence(env, room)
          .fetch(`https://presence.internal/settings-refresh?room=${encodeURIComponent(room)}`, {
            method: 'POST',
          })
          .catch(() => undefined),
      ),
    );
    return json(200, { commentsAllowed: body.allowed });
  }

  // ルームのファイル(VRM・ステージ)
  if (request.method === 'GET' && url.pathname === '/api/admin/files') {
    const room = url.searchParams.get('room') ?? '';
    if (!room || room.includes('/')) return json(400, { error: 'room が不正です' });
    const prefix = `${ROOM_FILES_PREFIX}${room}/`;
    const items: { key: string; size: number; uploaded: number }[] = [];
    let cursor: string | undefined;
    do {
      const page = await env.VRM_BUCKET.list({ prefix, cursor });
      for (const object of page.objects) {
        items.push({ key: object.key, size: object.size, uploaded: object.uploaded.getTime() });
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return json(200, { room, items });
  }

  /**
   * ファイルの削除。使用中なら席のアバター・ステージも外す
   * (消したファイルを指したままだと、視聴者の読み込みが404で失敗し続ける)
   */
  if (request.method === 'POST' && url.pathname === '/api/admin/files/delete') {
    const body = (await request.json()) as { key?: unknown };
    const key = typeof body.key === 'string' ? body.key : '';
    if (!isRoomFileKey(key)) return json(400, { error: 'このキーは削除できません' });
    const room = key.split('/')[1]!;
    await env.VRM_BUCKET.delete(key);
    await presence(env, room).fetch(
      `https://presence.internal/forget-file?room=${encodeURIComponent(room)}`,
      { method: 'POST', body: JSON.stringify({ key }) },
    );
    return json(200, { ok: true });
  }

  return json(404, { error: 'not found' });
}
