/**
 * ルームごとの視聴URL・配信者URLを生成する。
 * Worker側(worker/index.ts の roomToken)と同じ HMAC-SHA256 導出を行うので、
 * サーバーにルーム一覧を持たずに好きなだけルームを作れる。
 *
 *   npm run room -- <ルーム名> [オリジン]
 *
 * ROOM_SECRET は環境変数かリポジトリルートの .env から読む。
 * Worker側には `npx wrangler secret put ROOM_SECRET` で同じ値を設定しておく。
 */
import { createHmac } from 'node:crypto';
import { fileURLToPath } from 'node:url';

try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // .envが無ければ環境変数のみで動く
}

const TOKEN_LENGTH = 22;
const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const [room, originArg] = process.argv.slice(2);
const secret = process.env.ROOM_SECRET;
const origin = originArg ?? process.env.VIEWER_ORIGIN;

if (!room || !ROOM_PATTERN.test(room)) {
  console.error('使い方: npm run room -- <ルーム名> [オリジン]');
  console.error('ルーム名は英数字・ハイフン・アンダースコアの1〜64文字');
  process.exit(1);
}
if (!secret) {
  console.error('ROOM_SECRET が未設定です(.env か環境変数に設定してください)');
  process.exit(1);
}

const token = (scope) =>
  createHmac('sha256', secret).update(`${scope}:${room}`).digest('base64url').slice(0, TOKEN_LENGTH);

const base = origin ? origin.replace(/\/$/, '') : '<ビューアのオリジン>';
console.log(`ルーム    : ${room}`);
console.log(`視聴URL   : ${base}/watch/${room}/${token('watch')}`);
console.log(`配信者URL : ${base}/broadcast/${room}/${token('broadcast')}`);
console.log(`ブリッジ  : ROOM=${room} で起動する(.env に ROOM= を書くか環境変数で指定)`);
