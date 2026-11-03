// セットアップの実処理。wrangler の実行・設定ファイルの生成・ジョブの進行を持つ。
// HTTPの配線は server.mjs、画面は public/ 側にある。
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.resolve(here, '..', '..');
const viewerDir = path.join(repoRoot, 'apps', 'viewer');
const wranglerJsonc = path.join(viewerDir, 'wrangler.jsonc');
const wranglerExample = path.join(viewerDir, 'wrangler.example.jsonc');
// 生成したキーの控え。視聴URL・配信者URLの再表示と、再実行時のキー維持に使う。
// 秘密を含むため .gitignore 済み。消すと次回の実行でキーが再発行される(=URLが変わる)
const keysFile = path.join(repoRoot, '.setup-keys.json');
const envFile = path.join(repoRoot, '.env');
const tmpDir = path.join(here, '.tmp');

const WORKER_NAME = 'xroomcast';
const BUCKET_NAME = 'xroomcast-assets';
// wrangler 4 はバインディング名そのまま(SFU_STATE)で作る。旧版は「Worker名-」を前に付けていた
const KV_TITLES = ['SFU_STATE', `${WORKER_NAME}-SFU_STATE`];

// ---- セッション状態(メモリ) ----
export const session = {
  accountId: null,        // 複数アカウント時に選択
  realtime: null,         // { appId, secret } 検証済み
  vrm: null,              // { name, path, size } アップロード済みVRM
};

// ---- コマンド実行 ----

function maskSecrets(text) {
  let out = text;
  for (const v of collectSecretValues()) {
    if (v && v.length >= 8) out = out.split(v).join('***');
  }
  return out;
}

function collectSecretValues() {
  const vals = [];
  if (session.realtime) vals.push(session.realtime.secret);
  const keys = readKeys();
  if (keys) vals.push(...Object.values(keys.secrets ?? {}));
  return vals;
}

/**
 * コマンドを実行して {code, out} を返す。ジョブ実行中なら出力をログへ流す。
 * Windowsでは npx/npm が .cmd のため shell:true が要る。
 */
export function run(cmd, args, { cwd = repoRoot, env = {}, input, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        ...(session.accountId ? { CLOUDFLARE_ACCOUNT_ID: session.accountId } : {}),
        // wrangler の対話プロンプトを避ける(非対話で失敗してくれた方が扱える)
        CI: 'true',
        ...env,
      },
    });
    let out = '';
    const onChunk = (chunk) => {
      const text = chunk.toString();
      out += text;
      if (!quiet) jobLog(maskSecrets(text), 'cmd');
    };
    child.stdout.on('data', onChunk);
    child.stderr.on('data', onChunk);
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
    child.on('error', (err) => resolve({ code: -1, out: out + '\n' + err.message }));
    child.on('close', (code) => resolve({ code: code ?? -1, out }));
  });
}

const npx = (args, opts) => run('npx', ['--no-install', 'wrangler', ...args], opts);

// ---- ログイン状態 ----

export async function whoami() {
  const { out } = await npx(['whoami'], { quiet: true });
  const accounts = [];
  const rowRe = /[│|]\s*([^│|]+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]/g;
  for (const m of out.matchAll(rowRe)) {
    accounts.push({ name: m[1].trim(), id: m[2] });
  }
  const loggedIn = /logged in|associated with/i.test(out) || accounts.length > 0;
  return { loggedIn, accounts };
}

let loginChild = null;
export function startLogin() {
  if (loginChild) return; // 実行中
  // wrangler login は自前でブラウザを開き、コールバックを受けて勝手に完了する
  loginChild = spawn('npx', ['--no-install', 'wrangler', 'login'], {
    cwd: repoRoot,
    shell: process.platform === 'win32',
    stdio: 'ignore',
  });
  const clear = () => { loginChild = null; };
  loginChild.on('close', clear);
  loginChild.on('error', clear);
}

// ---- Realtime App の検証 ----

export async function verifyRealtime(appId, secret) {
  if (!/^[0-9a-f]{32}$/i.test(appId ?? '')) {
    return { ok: false, reason: 'App IDの形式が違います(32桁の英数字のはずです)' };
  }
  try {
    const res = await fetch(`https://rtc.live.cloudflare.com/v1/apps/${appId}/sessions/new`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(15000),
    });
    if (res.ok) {
      session.realtime = { appId, secret };
      return { ok: true };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'App ID または App Secret が一致しません。コピーし直してください' };
    }
    return { ok: false, reason: `Cloudflareの応答が想定外でした(HTTP ${res.status})` };
  } catch (err) {
    return { ok: false, reason: `Cloudflareへ接続できませんでした: ${err?.message ?? err}` };
  }
}

// ---- 既存セットアップの検出 ----

function readKeys() {
  try {
    return JSON.parse(fs.readFileSync(keysFile, 'utf8'));
  } catch {
    return null;
  }
}

export function detectExisting() {
  const hasConfig = fs.existsSync(wranglerJsonc);
  const keys = readKeys();
  return {
    hasWranglerConfig: hasConfig,
    hasKeys: keys != null,
    viewerUrl: keys?.viewerUrl ?? null,
    urls: keys ? buildUrls(keys) : null,
    // wrangler.jsonc があるのに控えが無い = このウィザード以外で構築された環境。
    // 上書きすると既存の運用を壊すため、画面側で明示的な同意を要求する
    foreign: hasConfig && keys == null,
  };
}

function buildUrls(keys) {
  if (!keys?.viewerUrl) return null;
  const base = keys.viewerUrl.replace(/\/$/, '');
  return {
    viewer: base,
    watch: `${base}/watch/${keys.secrets.WATCH_KEY}`,
    broadcast: `${base}/broadcast/${keys.secrets.BROADCAST_KEY}`,
  };
}

// ---- ジョブ(セットアップ本体の実行) ----

export const job = {
  status: 'idle',   // idle | running | done | error
  step: '',
  lines: [],
  result: null,
  errorHint: null,
};

function jobLog(text, kind = 'info') {
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    job.lines.push({ kind, line });
  }
  if (job.lines.length > 2000) job.lines.splice(0, job.lines.length - 2000);
}

function jobStep(title) {
  job.step = title;
  jobLog(`■ ${title}`, 'step');
}

function newSecret() {
  return randomBytes(18).toString('base64url'); // URLに載るためURLセーフで生成
}

export async function startSetupJob() {
  if (job.status === 'running') return { ok: false, reason: '実行中です' };
  if (!session.realtime) return { ok: false, reason: 'Realtime AppのID/Secretが未設定です' };
  job.status = 'running';
  job.lines = [];
  job.result = null;
  job.errorHint = null;
  runSetupJob().catch((err) => {
    jobLog(`予期しないエラー: ${err?.stack ?? err}`, 'error');
    job.status = 'error';
  });
  return { ok: true };
}

async function runSetupJob() {
  // 1. キーの用意(既存の控えがあれば再利用してURLを変えない)
  jobStep('アクセスキーを用意しています');
  const prev = readKeys();
  const secrets = prev?.secrets ?? {
    VRM_TOKEN: newSecret(),
    WATCH_KEY: newSecret(),
    BROADCAST_KEY: newSecret(),
    BRIDGE_TOKEN: newSecret(),
    ROOM_SECRET: newSecret(),
  };
  jobLog(prev ? '前回のキーを再利用します(URLは変わりません)' : '新しいキーを発行しました');

  // 2. wrangler.jsonc の生成(テンプレートから)
  jobStep('設定ファイル(wrangler.jsonc)を用意しています');
  let config = fs.readFileSync(wranglerExample, 'utf8');
  const vrmKey = session.vrm?.name ?? 'avatar.vrm';
  config = config.replace(/"DEFAULT_VRM_KEY":\s*"[^"]*"/, `"DEFAULT_VRM_KEY": ${JSON.stringify(vrmKey)}`);

  // 3. KVネームスペース(既存があれば流用)
  jobStep('KVネームスペースを用意しています');
  let kvId = await findExistingKv();
  if (kvId) {
    jobLog(`既存のKVネームスペースを使います (${kvId})`);
  } else {
    const { code, out } = await npx(['kv', 'namespace', 'create', 'SFU_STATE'], { cwd: viewerDir });
    kvId = out.match(/"?id"?\s*[:=]\s*"([0-9a-f]{32})"/)?.[1] ?? null;
    if ((code !== 0 || !kvId) && /already exists/i.test(out)) kvId = await findExistingKv();
    if (!kvId) {
      return fail('KVネームスペースの作成に失敗しました', hintFromOutput(out));
    }
  }
  config = config.replace(/"id":\s*"<[^"]*>"/, `"id": "${kvId}"`);
  fs.writeFileSync(wranglerJsonc, config);
  jobLog('wrangler.jsonc を書き出しました');

  // 4. R2バケット
  jobStep('R2バケットを用意しています');
  {
    const { code, out } = await npx(['r2', 'bucket', 'create', BUCKET_NAME], { cwd: viewerDir });
    if (code !== 0) {
      if (/already (exists|owns)/i.test(out)) {
        jobLog('既存のバケットを使います');
      } else if (/payment|billing|card/i.test(out)) {
        return fail('R2を使うにはCloudflareダッシュボードでR2の有効化(クレジットカード登録)が必要です',
          'https://dash.cloudflare.com/ → R2 → 有効化してから、もう一度実行してください');
      } else {
        return fail('R2バケットの作成に失敗しました', hintFromOutput(out));
      }
    }
  }

  // 5. デプロイ(ビルド込み。数分かかる)
  jobStep('ビルドしてCloudflareへデプロイしています(数分かかります)');
  const deploy = await run('npm', ['run', 'deploy'], { cwd: viewerDir });
  const viewerUrl = deploy.out.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0] ?? null;
  if (deploy.code !== 0 || !viewerUrl) {
    if (/subdomain/i.test(deploy.out)) {
      return fail('workers.dev のサブドメインが未登録です',
        'https://dash.cloudflare.com/ → Workers & Pages を開くとサブドメイン登録を案内されます。登録後にもう一度実行してください');
    }
    return fail('デプロイに失敗しました', hintFromOutput(deploy.out));
  }
  jobLog(`デプロイ完了: ${viewerUrl}`);

  // 6. シークレット登録(デプロイ後でないとWorkerが存在せず失敗する)
  jobStep('シークレットを登録しています');
  const bulk = {
    ...secrets,
    CF_REALTIME_APP_ID: session.realtime.appId,
    CF_REALTIME_APP_SECRET: session.realtime.secret,
  };
  const bulkFile = path.join(viewerDir, '.secrets.bulk.tmp.json');
  fs.writeFileSync(bulkFile, JSON.stringify(bulk));
  try {
    const { code, out } = await npx(['secret', 'bulk', path.basename(bulkFile)], { cwd: viewerDir });
    if (code !== 0) return fail('シークレットの登録に失敗しました', hintFromOutput(out));
  } finally {
    fs.rmSync(bulkFile, { force: true });
  }

  // 7. VRMをR2へ
  if (session.vrm) {
    jobStep('VRMファイルをアップロードしています');
    const { code, out } = await npx(
      ['r2', 'object', 'put', `${BUCKET_NAME}/${session.vrm.name}`, '--file', session.vrm.path, '--remote'],
      { cwd: viewerDir },
    );
    if (code !== 0) return fail('VRMのアップロードに失敗しました', hintFromOutput(out));
  } else {
    jobLog('VRM未指定のためスキップします(後で配信者コンソールからアップロードできます)', 'warn');
  }

  // 8. ブリッジ用 .env(既存があれば退避してから書く)
  jobStep('PC配信用の設定(.env)を書き出しています');
  if (fs.existsSync(envFile)) {
    const backup = `${envFile}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(envFile, backup);
    jobLog(`既存の .env を ${path.basename(backup)} として退避しました`, 'warn');
  }
  fs.writeFileSync(envFile, [
    '# セットアップウィザードが生成したファイル(PC配信のブリッジが読む)',
    `CF_REALTIME_APP_ID=${session.realtime.appId}`,
    `CF_REALTIME_APP_SECRET=${session.realtime.secret}`,
    `VIEWER_ORIGIN=${viewerUrl}`,
    `BRIDGE_TOKEN=${secrets.BRIDGE_TOKEN}`,
    `ROOM_SECRET=${secrets.ROOM_SECRET}`,
    'ROOM=main',
    '# 複数PCで配信するときは別の名前にする(SETUP.md 3-4)',
    '# PUBLISHER_ID=',
    '',
  ].join('\n'));

  // 9. 控えの保存
  fs.writeFileSync(keysFile, JSON.stringify({ viewerUrl, secrets, updatedAt: new Date().toISOString() }, null, 2));

  job.result = buildUrls({ viewerUrl, secrets });
  job.status = 'done';
  jobStep('完了しました');
}

function fail(message, hint) {
  jobLog(message, 'error');
  if (hint) jobLog(hint, 'error');
  job.errorHint = hint ?? null;
  job.status = 'error';
}

function hintFromOutput(out) {
  const tail = out.trim().split(/\r?\n/).slice(-6).join('\n');
  return tail || null;
}

async function findExistingKv() {
  const { code, out } = await npx(['kv', 'namespace', 'list'], { cwd: viewerDir, quiet: true });
  if (code !== 0) return null;
  // 出力にはバナー行が混ざるため、JSONとして読める '[' を探す
  for (let i = out.indexOf('['); i !== -1; i = out.indexOf('[', i + 1)) {
    try {
      const list = JSON.parse(out.slice(i));
      if (Array.isArray(list)) return list.find((ns) => KV_TITLES.includes(ns.title))?.id ?? null;
    } catch { /* 次の '[' を試す */ }
  }
  return null;
}

// ---- VRMアップロードの受け口 ----

export function saveVrm(name, buffer) {
  const safe = path.basename(name || 'avatar.vrm');
  if (!/\.vrm$/i.test(safe)) return { ok: false, reason: 'VRMファイル(.vrm)を選んでください' };
  fs.mkdirSync(tmpDir, { recursive: true });
  const dest = path.join(tmpDir, safe);
  fs.writeFileSync(dest, buffer);
  session.vrm = { name: safe, path: dest, size: buffer.length };
  return { ok: true, name: safe, size: buffer.length };
}
