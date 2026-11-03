/**
 * 中継アプリ(Electron)を束ねる。main と preload を CommonJS にまとめ、画面のファイルを dist へ写す。
 *
 * 中継の処理(apps/bridge)は依存ごと束ねるので、配るアプリに node_modules は入れない。
 * ただし node-datachannel のネイティブアドオン(.node)は束ねられないので、electron-builder の
 * extraResources でアプリの resources フォルダへ置き、そこから読む(開発中はリポジトリの node_modules から)
 */
import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const dist = path.join(root, 'dist');
const require = createRequire(import.meta.url);

const resolved = require.resolve('node-datachannel');
const datachannelRoot = resolved.slice(0, resolved.lastIndexOf('node-datachannel') + 'node-datachannel'.length);
const devAddon = path.join(datachannelRoot, 'build', 'Release', 'node_datachannel.node');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

/** node-datachannel の .node を、配ったアプリでは resources フォルダから読む */
const nativeAddonPlugin = {
  name: 'node-datachannel-native',
  setup(build) {
    build.onLoad(
      { filter: /node-datachannel[\\/]dist[\\/](esm|cjs)[\\/]lib[\\/]node-datachannel\.(mjs|cjs)$/ },
      () => ({
        loader: 'js',
        contents: `
          const path = require('node:path');
          // 配ったアプリでは束ねたファイルが app.asar の中にある
          const packaged = __dirname.includes('app.asar');
          const file = packaged
            ? path.join(process.resourcesPath, 'node_datachannel.node')
            : ${JSON.stringify(devAddon)};
          const addonModule = { exports: {} };
          process.dlopen(addonModule, file);
          const binding = addonModule.exports;
          export default binding;
        `,
      }),
    );
  },
};

const common = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  // CommonJS には import.meta が無い。中継の処理は開発用の経路でしか使わないが、評価できる値にしておく
  banner: { js: "const __importMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  define: { 'import.meta.url': '__importMetaUrl' },
  plugins: [nativeAddonPlugin],
  logLevel: 'warning',
};

await esbuild.build({ ...common, entryPoints: [path.join(root, 'src', 'main.ts')], outfile: path.join(dist, 'main.cjs') });
// preload は sandbox で動くので、electron 以外を require できない(import.meta の置き換えも要らない)
await esbuild.build({
  ...common,
  banner: undefined,
  define: undefined,
  plugins: [],
  entryPoints: [path.join(root, 'src', 'preload.ts')],
  outfile: path.join(dist, 'preload.cjs'),
});
cpSync(path.join(root, 'renderer'), path.join(dist, 'renderer'), { recursive: true });
console.log('[build] dist に束ねました');
