/**
 * VMCブリッジのコンソール版(実装仕様書 §5 Phase 2b)。本体は bridge.ts。
 *
 * 設定は settings.ts。配布版は配信者URLだけで動き、App Secret を持たない。
 * 単一の実行ファイル(Node.js の SEA)にしても動くよう、ソースの位置(import.meta.url)には
 * 開発用の経路(.env・ローカル配信のVRM)でしか頼らない
 */
import { fileURLToPath } from 'node:url';
import { isSea } from 'node:sea';
import { connect, disconnect, startBridge } from './bridge.js';
import { loadSettings } from './settings.js';
import { offerConsole } from './console.js';

// osc-min が古い Buffer() を使っていて、起動のたびに非推奨の警告が出る(動作には関係ない)
process.noDeprecation = true;

// 開発用: リポジトリルートの .env を読む(App Secretをコード・ブラウザに出さないため)。
// 実行ファイル版はソースの位置が無いので読まない(設定は配信者URLだけ)
if (!isSea()) {
  try {
    process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
  } catch {
    // .envが無ければ環境変数のみで動く
  }
}

/** 設定で止まったときは、窓がすぐ閉じないよう Enter を待ってから終わる(ダブルクリックで起動したとき用) */
async function exitAfterKey(code: number): Promise<never> {
  if (process.stdin.isTTY) {
    console.log('Enter を押すと終了します');
    await new Promise((resolve) => process.stdin.once('data', resolve));
  }
  process.exit(code);
}

async function main(): Promise<void> {
  // 配信者URLを聞いている間も、VMC の受信は進めておく
  startBridge();

  let settings;
  try {
    settings = await loadSettings();
  } catch (error) {
    console.error(`[設定] ${error instanceof Error ? error.message : String(error)}`);
    console.error('[設定] 配信者URLを入れ直すときは --reset を付けて起動してください');
    return exitAfterKey(1);
  }
  await connect(settings);

  // Ctrl+C・窓を閉じたときは席をすぐ空ける(視聴側に15分残さない)。
  // Windows で窓を閉じると SIGHUP が来る(10秒ほどで強制終了されるので、それまでに送る)
  const shutdown = (): void => {
    void disconnect().finally(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.once('SIGHUP', shutdown);

  // 配布版: マイクとアバターの設定に使う配信者コンソールを、この席の名前で開けるようにする
  if (settings.mode === 'worker') offerConsole(settings);
}

void main();
