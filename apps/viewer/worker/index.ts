/**
 * ビューアWorker: 静的アセット配信に加えて、R2の非公開バケットから
 * VRMを同一オリジンで配信する(/vrm/<キー>?k=<トークン>)。
 * - バケットは非公開のまま(=直リンク不可)。トークン照合を通った場合のみ返す
 * - 同一オリジンなのでCORS設定は不要
 * - トークンは `wrangler secret put VRM_TOKEN` で設定。ローテートすれば旧リンクは無効化
 */
interface Env {
  ASSETS: Fetcher;
  VRM_BUCKET: R2Bucket;
  VRM_TOKEN?: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/vrm/')) {
      if (request.method !== 'GET') {
        return new Response('method not allowed', { status: 405 });
      }
      // トークン未設定時は配信自体を無効にする(安全側)
      if (!env.VRM_TOKEN || url.searchParams.get('k') !== env.VRM_TOKEN) {
        return new Response('forbidden', { status: 403 });
      }
      const key = decodeURIComponent(url.pathname.slice('/vrm/'.length));
      const object = await env.VRM_BUCKET.get(key);
      if (!object) {
        return new Response('not found', { status: 404 });
      }
      return new Response(object.body, {
        headers: {
          'Content-Type': 'application/octet-stream',
          'Content-Length': String(object.size),
          'Cache-Control': 'private, no-store',
        },
      });
    }

    return env.ASSETS.fetch(request);
  },
};
