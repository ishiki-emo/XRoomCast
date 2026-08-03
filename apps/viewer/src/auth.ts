/**
 * このアプリの資格情報の組み立て。
 *
 * 「URLに載ってきた鍵をそのまま使う」という**このアプリ固有の方針**をここに置く。
 * 資格情報の抽象そのもの(`AuthProvider`)はライブラリ側(@xroomcast/sync)にあり、
 * 事業者が独自の会員認証を載せる場合は、この関数に相当するものを自分で書いて
 * `AuthProvider` を返せばよい(ライブラリ側の変更は要らない)。
 * サーバー側の対になる差し替え点は worker/auth.ts の `authorize()`。
 */
import { anonymousAuth, bearerAuth, type AuthProvider } from '@xroomcast/sync';
import type { AppConfig } from './config';

/**
 * 配信者キー(`?key=`)を持っていればそちらを優先する(配信者は視聴もできるため)。
 * 視聴トークン(`?wt=`)は /watch/<ルーム>/<トークン> から引き継がれたもの。
 */
export function createAuth(config: AppConfig): AuthProvider {
  if (config.broadcastKey) return bearerAuth(config.broadcastKey, 'key');
  if (config.viewerToken) return bearerAuth(config.viewerToken, 'wt');
  return anonymousAuth;
}
