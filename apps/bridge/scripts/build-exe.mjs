/**
 * 中継プログラムを、Node.js を入れずに動く単一の実行ファイルにする(Node.js の Single Executable Applications)。
 *
 *   npm run build:exe -w apps/bridge
 *
 * 1. esbuild で src/index.ts を1つの CommonJS に束ねる(SEA の main は CommonJS でなければならない)
 * 2. node-datachannel のネイティブアドオン(.node)は実行ファイルの中から直接読めないので、asset として
 *    同梱し、起動時に一時フォルダへ書き出して process.dlopen() で読む(束ねるときに読み込み部分を差し替える)
 * 3. SEA の blob を作り、このビルドに使っている node 本体の複製へ postject で注入する
 *
 * 出来るのは今の OS・CPU 用の実行ファイルだけ(ネイティブアドオンが OS ごとに違うため)。
 * blob は注入先と同じ版の node で作る必要があるので、process.execPath をそのまま複製する
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
const require = createRequire(import.meta.url);
const version = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')).version;

const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
const exeName = `xroomcast-bridge-${platform}-${process.arch}${process.platform === 'win32' ? '.exe' : ''}`;

// node-datachannel のネイティブアドオン(npm install のときに、この OS 用のものが入っている)
const resolved = require.resolve('node-datachannel');
const datachannelRoot = resolved.slice(0, resolved.lastIndexOf('node-datachannel') + 'node-datachannel'.length);
const addon = path.join(datachannelRoot, 'build', 'Release', 'node_datachannel.node');
const ADDON_ASSET = 'node_datachannel.node';

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** node-datachannel の .node の読み込みを、SEA の asset から読む形に差し替える */
const nativeAddonPlugin = {
  name: 'node-datachannel-native',
  setup(build) {
    build.onLoad({ filter: /node-datachannel[\\/]dist[\\/](esm|cjs)[\\/]lib[\\/]node-datachannel\.(mjs|cjs)$/ }, () => ({
      loader: 'js',
      contents: `
        const sea = require('node:sea');
        const fs = require('node:fs');
        const os = require('node:os');
        const path = require('node:path');
        const crypto = require('node:crypto');
        function load() {
          const addonModule = { exports: {} };
          if (!sea.isSea()) {
            // 束ねたファイルを node で直接動かすとき(確かめる用)
            process.dlopen(addonModule, ${JSON.stringify(addon)});
            return addonModule.exports;
          }
          // 版ごとに別のフォルダへ書き出す(古い版の exe と同時に動いても上書きし合わない)
          const raw = Buffer.from(sea.getRawAsset(${JSON.stringify(ADDON_ASSET)}));
          const hash = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 12);
          const dir = path.join(os.tmpdir(), 'xroomcast-bridge-' + hash);
          const file = path.join(dir, ${JSON.stringify(ADDON_ASSET)});
          if (!fs.existsSync(file)) {
            fs.mkdirSync(dir, { recursive: true });
            const temp = file + '.' + process.pid + '.tmp';
            fs.writeFileSync(temp, raw);
            try {
              fs.renameSync(temp, file);
            } catch {
              // 同時に起動した別の exe が先に書き終えた
              fs.rmSync(temp, { force: true });
            }
          }
          process.dlopen(addonModule, file);
          return addonModule.exports;
        }
        // 差し替え元は ESM(export default)と CommonJS(exports.default)の両方。どちらからも default で取る
        const binding = load();
        export default binding;
      `,
    }));
  },
};

console.log('[build] 1/3 束ねています');
const bundle = path.join(dist, 'bridge.cjs');
await esbuild.build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: bundle,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  // ws の任意依存(無ければ JavaScript 版で動く)
  external: ['bufferutil', 'utf-8-validate'],
  // CommonJS には import.meta が無い。開発用の経路でしか使わないが、評価できる値にしておく
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl', 'process.env.BRIDGE_VERSION': JSON.stringify(version) },
  plugins: [nativeAddonPlugin],
  logLevel: 'warning',
});

console.log('[build] 2/3 SEA の blob を作っています');
const blob = path.join(dist, 'sea-prep.blob');
const seaConfig = path.join(dist, 'sea-config.json');
writeFileSync(
  seaConfig,
  JSON.stringify({
    main: bundle,
    output: blob,
    disableExperimentalSEAWarning: true,
    useCodeCache: false,
    assets: { [ADDON_ASSET]: addon },
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

console.log('[build] 3/3 node 本体に注入しています');
const exe = path.join(dist, exeName);
copyFileSync(process.execPath, exe);
if (process.platform === 'darwin') {
  // 署名が残っていると注入できない。注入後に ad-hoc 署名し直す
  execFileSync('codesign', ['--remove-signature', exe]);
}
const postject = path.join(path.dirname(require.resolve('postject')), 'cli.js');
execFileSync(
  process.execPath,
  [
    postject,
    exe,
    'NODE_SEA_BLOB',
    blob,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(process.platform === 'darwin' ? ['--macho-segment-name', 'NODE_SEA'] : []),
  ],
  { stdio: 'inherit' },
);
if (process.platform === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);

rmSync(blob, { force: true });
rmSync(seaConfig, { force: true });
console.log(`[build] できました: ${path.relative(process.cwd(), exe)}`);
