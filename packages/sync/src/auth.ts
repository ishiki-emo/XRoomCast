/**
 * クライアント側の資格情報の取り出し口。
 *
 * 以前は `Authorization: Bearer ${key}` が5つのモジュールに直書きされ、
 * 出所も各々が `?key=` を読むという状態だったため、認証方式を変えるには
 * 全部を書き換える必要があった。ここへ一本化して、**差し替え点を1つにする**。
 *
 * 独自の会員認証(IdPのJWT、セッションCookie等)を載せる場合は、この
 * `AuthProvider` を自前で実装して各モジュールへ渡せばよい。呼び出し側は
 * 「ヘッダに載せる」か「クエリに載せる」かだけを知っていればよい。
 * サーバー側の対になる差し替え点は worker/auth.ts の `authorize()`。
 */
import { withRoom } from './room';

export interface AuthProvider {
  /**
   * fetch / XHR のヘッダに載せる資格情報。持たないときは空オブジェクト。
   * トークンの更新(リフレッシュ)を挟めるよう非同期にしてある
   */
  headers(): Promise<Record<string, string>>;
  /**
   * ヘッダを付けられない経路のためのクエリ文字列(`key=...` 等、先頭の区切りは含まない)。
   * ブラウザのWebSocketは `Authorization` を付けられず、`sendBeacon` も同様なので、
   * presenceの接続とタブを閉じる際の登録解除はこちらを使う。
   * 持たないときは空文字列
   */
  query(): string;
}

/** 資格情報を持たない(ローカル開発・匿名視聴) */
export const anonymousAuth: AuthProvider = {
  headers: () => Promise.resolve({}),
  query: () => '',
};

/**
 * 単一のトークンをBearerヘッダとクエリの両方で送る実装。
 * 「URLに載ってきた鍵をそのまま使う」既定の方式はこれで足りる。
 * @param queryName ヘッダを使えない経路で用いるクエリ名(配信者は `key`、視聴は `wt`)
 */
export function bearerAuth(token: string, queryName: string): AuthProvider {
  if (!token) return anonymousAuth;
  return {
    headers: () => Promise.resolve({ Authorization: `Bearer ${token}` }),
    query: () => `${queryName}=${encodeURIComponent(token)}`,
  };
}

/**
 * APIパスにルームと、ヘッダを使えない経路向けの資格情報を付ける。
 * ヘッダを付けられる経路では `withRoom()` + `auth.headers()` を使う
 */
export function withAuth(path: string, room: string, auth: AuthProvider): string {
  const base = withRoom(path, room);
  const query = auth.query();
  return query ? `${base}&${query}` : base;
}
