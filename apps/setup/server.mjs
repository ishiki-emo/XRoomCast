// セットアップウィザードのローカルサーバー。
// 画面(public/)を配信し、実処理(steps.mjs)へのAPIを提供する。
// 127.0.0.1 にのみバインドし、外部からは繋がらない。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as steps from './steps.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, 'public');
const noOpen = process.argv.includes('--no-open');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readBody(req, limit = 200 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limit) throw new Error('too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    // ---- API ----
    if (url.pathname === '/api/state' && req.method === 'GET') {
      const [login, existing] = await Promise.all([steps.whoami(), steps.detectExisting()]);
      return json(res, 200, {
        node: process.version,
        login,
        accountId: steps.session.accountId,
        realtimeOk: steps.session.realtime != null,
        vrm: steps.session.vrm ? { name: steps.session.vrm.name, size: steps.session.vrm.size } : null,
        existing,
      });
    }
    if (url.pathname === '/api/login/start' && req.method === 'POST') {
      steps.startLogin();
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/account' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)).toString());
      if (!/^[0-9a-f]{32}$/.test(body.accountId ?? '')) return json(res, 400, { ok: false });
      steps.session.accountId = body.accountId;
      return json(res, 200, { ok: true });
    }
    if (url.pathname === '/api/realtime' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req, 4096)).toString());
      const result = await steps.verifyRealtime((body.appId ?? '').trim(), (body.secret ?? '').trim());
      return json(res, 200, result);
    }
    if (url.pathname === '/api/vrm' && req.method === 'POST') {
      const buffer = await readBody(req);
      const result = steps.saveVrm(url.searchParams.get('name'), buffer);
      return json(res, result.ok ? 200 : 400, result);
    }
    if (url.pathname === '/api/run' && req.method === 'POST') {
      const result = await steps.startSetupJob();
      return json(res, result.ok ? 200 : 409, result);
    }
    if (url.pathname === '/api/job' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') ?? 0);
      return json(res, 200, {
        status: steps.job.status,
        step: steps.job.step,
        lines: steps.job.lines.slice(since),
        total: steps.job.lines.length,
        result: steps.job.result,
        errorHint: steps.job.errorHint,
      });
    }

    // ---- 静的ファイル ----
    let file = url.pathname === '/' ? '/index.html' : url.pathname;
    file = path.normalize(file).replace(/^([.\\/])+/, '');
    const full = path.join(publicDir, file);
    if (!full.startsWith(publicDir) || !fs.existsSync(full)) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] ?? 'application/octet-stream' });
    return res.end(fs.readFileSync(full));
  } catch (err) {
    return json(res, 500, { ok: false, reason: String(err?.message ?? err) });
  }
});

function listen(port) {
  server.once('error', (err) => {
    if (err.code === 'EADDRINUSE' && port < 8790) listen(port + 1);
    else throw err;
  });
  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}`;
    console.log('');
    console.log('  XRoomCast セットアップウィザード');
    console.log(`  ブラウザで ${url} を開いてください(自動で開きます)`);
    console.log('  終了するにはこのウィンドウを閉じてください');
    console.log('');
    if (!noOpen) {
      if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', url], { stdio: 'ignore' });
      else if (process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore' });
      else spawn('xdg-open', [url], { stdio: 'ignore' });
    }
  });
}

listen(8756);
