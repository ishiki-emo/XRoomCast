/**
 * URLクエリから読む実行時設定の集約。
 * 以前は main.ts の冒頭と末尾にパースが散っていたため、ルーム・ロールを足す前に
 * ここへ一本化した。ページ(視聴ビューア/配信者コンソール)から共通で使う。
 */

export type TransportKind = 'ws' | 'sfu';

/**
 * ロール。将来アバターを持つ参加者(participant)を足せるよう真偽値ではなく型で持つ。
 * - viewer: 視聴専用(?watch=1)。操作UIを隠したレイアウトになる
 * - studio: 開発・検証用のフルUI(既定)
 */
export type Role = 'viewer' | 'studio';

export const DEFAULT_ROOM = 'main';
/** ローカル開発で読む既定VRM。apps/viewer/public/ に置く(コミット対象外) */
export const DEFAULT_VRM_PATH = '/avatar.vrm';

/**
 * ルーム名はDurable Objectの名前・KVキー・R2キーの一部になるため文字種を制限する。
 * Worker側(worker/index.ts)にも同じ規則の実装があり、両方を通過したものだけが有効。
 */
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function normalizeRoom(value: string | null | undefined): string {
  const room = (value ?? '').trim();
  return ROOM_PATTERN.test(room) ? room : DEFAULT_ROOM;
}

/**
 * 既定の接続先。SFUはHTTPS(=Worker配信)なら同一オリジンのプロキシAPIを使い、
 * ローカル開発(http)ではブリッジ直結。WSはビューアを開いたホストのブリッジへ
 */
export function defaultServerUrls(loc: Location = location): Record<TransportKind, string> {
  return {
    ws: `ws://${loc.hostname}:8080`,
    sfu: loc.protocol === 'https:' ? loc.origin : `http://${loc.hostname}:8080`,
  };
}

export interface AppConfig {
  /** 参加するルーム。SFU・同接・コメントの分離単位 */
  room: string;
  role: Role;
  /** 視聴モード(操作UIを隠す)。role === 'viewer' の別名 */
  watchMode: boolean;
  /** ロードするVRM(未指定なら既定パス) */
  vrmUrl: string;
  transport: TransportKind;
  /** 接続先。?server= が無ければ transport に応じた既定値 */
  serverUrl: string;
  /** ?transport= / ?server= が付いていれば開いた直後に接続する */
  autoConnect: boolean;
  /** 配信者コンソールのキー(?key=)。視聴ページでは空 */
  broadcastKey: string;
}

export function readConfig(search: string = location.search, loc: Location = location): AppConfig {
  const params = new URLSearchParams(search);
  const defaults = defaultServerUrls(loc);

  const serverParam = params.get('server');
  const transportParam = params.get('transport');
  // ?server= だけの指定でもスキームからトランスポート種別を推測する(従来互換)。
  // どちらも無いときの既定は index.html のセレクト先頭(WebSocket)に合わせる
  const transport: TransportKind = transportParam
    ? transportParam === 'ws'
      ? 'ws'
      : 'sfu'
    : serverParam
      ? serverParam.startsWith('ws')
        ? 'ws'
        : 'sfu'
      : 'ws';

  const role: Role = params.get('watch') === '1' ? 'viewer' : 'studio';

  return {
    room: normalizeRoom(params.get('room')),
    role,
    watchMode: role === 'viewer',
    vrmUrl: params.get('vrm') ?? DEFAULT_VRM_PATH,
    transport,
    serverUrl: serverParam ?? defaults[transport],
    autoConnect: Boolean(serverParam || transportParam),
    broadcastKey: params.get('key') ?? '',
  };
}

/** APIパスにルームを付ける(Worker側は ?room= で受ける) */
export function withRoom(path: string, room: string): string {
  const separator = path.includes('?') ? '&' : '?';
  return `${path}${separator}room=${encodeURIComponent(room)}`;
}
