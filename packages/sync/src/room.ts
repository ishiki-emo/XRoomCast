/**
 * ルーム(同時に複数の配信を成立させる単位)の共通規則。
 * SFUのパブリッシャー・同接・コメントはすべてルームごとに分かれる。
 */

export const DEFAULT_ROOM = 'main';

/**
 * ルーム名はDurable Objectの名前・KVキー・R2キーの一部になるため文字種を制限する。
 * サーバー側(worker/index.ts)にも同じ規則の実装があり、両方を通過したものだけが有効。
 */
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeRoom(value: string | null | undefined): string {
  const room = (value ?? '').trim();
  return ROOM_PATTERN.test(room) ? room : DEFAULT_ROOM;
}

/**
 * APIパスにルームを付ける(サーバー側は ?room= で受ける)。
 * 資格情報も一緒に載せたい場合は `withAuth()` を使う
 */
export function withRoom(path: string, room: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}room=${encodeURIComponent(room)}`;
}
