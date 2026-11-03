import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// バージョンはリポジトリルートの package.json だけで管理する。
// ここで埋め込むことで、画面表示のために二重に書かずに済む
const { version } = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../package.json', import.meta.url)), 'utf8'),
) as { version: string };

// 視聴ページ(index.html)・配信者コンソール(broadcast.html)・管理画面(admin.html)のマルチページ構成
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        broadcast: fileURLToPath(new URL('broadcast.html', import.meta.url)),
        admin: fileURLToPath(new URL('admin.html', import.meta.url)),
      },
    },
  },
});
