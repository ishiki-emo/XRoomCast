/**
 * ルームの台帳(KV `room:<ルーム>`)。**運営者が管理画面で開設したルームだけが使える。**
 *
 * - 開設していないルーム・閉鎖したルームは、配信も視聴もアップロードも入口で断る
 * - 閉鎖したルームを再び開設すると「URLの世代」が上がり、視聴URL・配信者URLが作り直される
 *   (閉鎖前に配ったURLは使えないまま)。世代0は従来どおりの計算なので、既存のURLは変わらない
 * - 既定ルーム(main)は台帳に無くても開設済みとして扱う(ウィザードが作るURLの互換のため)
 * - 値が数字だけのものは、台帳を入れる前に管理画面の一覧用に書いていた「最初に見えた時刻」。
 *   その時点で使われていたルームなので、開設済み・世代0として扱う
 */

export const ROOM_INDEX_PREFIX = 'room:';

/** 既定ルーム。ルームを指定しない従来のURLはここに入る */
export const DEFAULT_ROOM = 'main';
/**
 * ルーム名はDurable Objectの名前・KVキーの一部になるため文字種を制限する。
 * ビューア側(src/config.ts)にも同じ規則がある
 */
export const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface RoomRecord {
  status: 'open' | 'closed';
  /** URLの世代。再開設のたびに上がる */
  gen: number;
  openedAt: number;
  closedAt?: number;
}

/**
 * 入口のたびに読むので、エッジのキャッシュを使う。閉鎖が全拠点へ効くまで最大この秒数かかるが、
 * 接続中の人はDurable Objectがその場で切るので、遅れるのは新しく来た人の拒否だけ
 */
const READ_CACHE_TTL_SEC = 30;

export async function readRoom(
  kv: KVNamespace,
  room: string,
  defaultRoom: string,
  options: { fresh?: boolean } = {},
): Promise<RoomRecord | null> {
  const raw = await kv.get(
    `${ROOM_INDEX_PREFIX}${room}`,
    options.fresh ? undefined : { cacheTtl: READ_CACHE_TTL_SEC },
  );
  if (raw === null) {
    return room === defaultRoom ? { status: 'open', gen: 0, openedAt: 0 } : null;
  }
  if (/^\d+$/.test(raw)) return { status: 'open', gen: 0, openedAt: Number(raw) };
  try {
    const record = JSON.parse(raw) as RoomRecord;
    return record.status === 'open' || record.status === 'closed' ? record : null;
  } catch {
    return null;
  }
}

export function isOpen(record: RoomRecord | null): record is RoomRecord & { status: 'open' } {
  return record?.status === 'open';
}

/** 開設する。閉鎖していたルームなら世代を上げてURLを作り直す。開設中なら何もしない */
export async function openRoom(
  kv: KVNamespace,
  room: string,
  defaultRoom: string,
  now = Date.now(),
): Promise<{ record: RoomRecord; reopened: boolean }> {
  const current = await readRoom(kv, room, defaultRoom, { fresh: true });
  if (isOpen(current) && current.openedAt !== 0) return { record: current, reopened: false };
  const reopened = current?.status === 'closed';
  const record: RoomRecord = {
    status: 'open',
    gen: reopened ? current.gen + 1 : (current?.gen ?? 0),
    openedAt: now,
  };
  await kv.put(`${ROOM_INDEX_PREFIX}${room}`, JSON.stringify(record));
  return { record, reopened };
}

export async function closeRoom(
  kv: KVNamespace,
  room: string,
  defaultRoom: string,
  now = Date.now(),
): Promise<RoomRecord | null> {
  const current = await readRoom(kv, room, defaultRoom, { fresh: true });
  if (!current) return null;
  const record: RoomRecord = { ...current, status: 'closed', closedAt: now };
  await kv.put(`${ROOM_INDEX_PREFIX}${room}`, JSON.stringify(record));
  return record;
}
