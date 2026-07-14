import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

// 視聴ページ(index.html)と配信者コンソール(broadcast.html)のマルチページ構成
export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('index.html', import.meta.url)),
        broadcast: fileURLToPath(new URL('broadcast.html', import.meta.url)),
      },
    },
  },
});
