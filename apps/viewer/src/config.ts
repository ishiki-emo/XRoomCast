/**
 * URLクエリから読む実行時設定の集約。
 * 以前は main.ts の冒頭と末尾にパースが散っていたため、ルーム・ロールを足す前に
 * ここへ一本化した。ページ(視聴ビューア/配信者コンソール)から共通で使う。
 *
 * ここは**このアプリ固有**の層。ライブラリ(@xroomcast/sync, viewer-core)は
 * URLを読まず、設定を引数で受け取る。事業者が自社アプリに組み込む場合は
 * このファイルに相当するものを自分で書くことになる。
 */
import { normalizeRoom } from '@xroomcast/sync';

export type TransportKind = 'ws' | 'sfu';

/**
 * ロール。将来アバターを持つ参加者(participant)を足せるよう真偽値ではなく型で持つ。
 * - viewer: 視聴専用(?watch=1)。操作UIを隠したレイアウトになる
 * - studio: 開発・検証用のフルUI(既定)
 */
export type Role = 'viewer' | 'studio';

/** ローカル開発で読む既定VRM。apps/viewer/public/ に置く(コミット対象外) */
export const DEFAULT_VRM_PATH = '/avatar.vrm';

/**
 * 既定の接続先。SFUはHTTPS(=Worker配信)なら同一オリジンのプロキシAPIを使い、
 * ローカル開発(http)ではブリッジ直結。WSはビューアを開いたホストのブリッジへ
 */
export function defaultServerUrls(loc: Location = location): Record<TransportKind, string> {
  return {
    ws: `ws://${loc.hostname}:8080`,
    // SFUのプロキシAPIはWorkerが持つ。ビルド済みバンドル(= Workerが配信している
    // ページ)なら同一オリジン、vite開発サーバーならブリッジのローカルAPIへ。
    // ここをhttps判定にすると `wrangler dev`(http)で接続先がブリッジになり、
    // 視聴ページだけモーションが来ない(配信者コンソールは location.origin 直指定
    // なので動いてしまい、原因が分かりにくい)
    sfu: import.meta.env.PROD ? loc.origin : `http://${loc.hostname}:8080`,
  };
}

/**
 * 同一オリジンのWebSocket URLを組み立てる。
 * ページがhttpsなら wss、httpなら ws。**決め打ちにすると
 * `wrangler dev`(http)でpresenceに繋がらず、コメントも同接も動かない。**
 */
export function sameOriginWebSocketUrl(path: string, loc: Location = location): string {
  return `${loc.protocol === 'https:' ? 'wss' : 'ws'}://${loc.host}${path}`;
}

/**
 * ルームごとの設定。サーバー(Presence Durable Object)が真の値を持ち、
 * 接続時と変更時に押し出してくる。**公開配信・非公開配信・イベント会場を
 * 別物として作らず、ここの切り替えだけで賄う**のが方針
 */
export interface RoomSettings {
  /** public: 誰でも視聴できる / invite: 視聴トークンが要る */
  access: 'public' | 'invite';
  /** 匿名コメントの可否 */
  chat: boolean;
  /** 同時接続の上限(null で無制限) */
  capacity: number | null;
  /** 視聴者の気配の公開範囲 */
  peerMode: 'all' | 'broadcaster' | 'off';
  /** 視聴者の発話(プッシュトゥトーク)。未実装のため常に false */
  viewerVoice: boolean;
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
  /**
   * 視聴トークン(?wt=)。/watch/<ルーム>/<トークン> から引き継がれる。
   * Worker側が REQUIRE_VIEWER_TOKEN='1' のときだけ検証される(既定では素通し)
   */
  viewerToken: string;
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
    viewerToken: params.get('wt') ?? '',
  };
}
