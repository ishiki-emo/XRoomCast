/**
 * 中継プログラムの設定。配信者に配るときは「配信者URLを貼るだけ」で動くようにする。
 *
 * 2つの動かし方がある:
 * - worker(配布版・推奨): 配信者URL(管理画面が出す /broadcast/<ルーム>/<キー>)から、Worker の URL・
 *   ルーム・配信者キーを取り出し、SFU は Worker の中継 API を配信者キーで使う。PCに置く秘密は
 *   そのルームの配信者キーだけ(ルームを閉じれば無効になる)
 * - direct(開発用・従来どおり): リポジトリの .env の CF_REALTIME_APP_SECRET で SFU を直接叩く。
 *   App Secret は全ルーム共通で取り消せないので、配信者には渡さない
 *
 * 配信者URLは、利用者ごとの設定フォルダの bridge.json に保存する(exe の横やリポジトリには置かない)。
 * 決め方の順番: 起動時の --url / 環境変数 BROADCAST_URL → 保存済みの URL → .env の App Secret(direct)
 * → コンソールで聞く
 */
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

export interface WorkerSettings {
  mode: 'worker';
  /** Worker の URL(例: https://xroomcast.example.workers.dev) */
  origin: string;
  room: string;
  /** 配信者キー。Authorization: Bearer で送る */
  key: string;
  pid: string;
}

export interface DirectSettings {
  mode: 'direct';
  appId: string;
  appSecret: string;
  /** パブリッシャー登録先。無ければ登録しない(ローカルの WebSocket だけで使う) */
  viewerOrigin: string | null;
  bridgeToken: string | null;
  room: string;
  pid: string;
}

export type BridgeSettings = WorkerSettings | DirectSettings;

interface SavedConfig {
  broadcastUrl?: string;
  pid?: string;
}

const ROOM_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
/** Worker の PID_PATTERN と同じ。外れると Worker 側で 'default' 扱いになり、席を取り合う */
const PID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

/** 利用者ごとの設定フォルダ(Windows: %APPDATA%\XRoomCast、macOS: ~/Library/Application Support/XRoomCast) */
export function configDir(): string {
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'XRoomCast');
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'XRoomCast');
  }
  return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'xroomcast');
}

const configFile = (): string => path.join(configDir(), 'bridge.json');

function readSaved(): SavedConfig {
  try {
    return JSON.parse(readFileSync(configFile(), 'utf8')) as SavedConfig;
  } catch {
    return {};
  }
}

function writeSaved(config: SavedConfig): void {
  mkdirSync(configDir(), { recursive: true });
  writeFileSync(configFile(), `${JSON.stringify(config, null, 2)}\n`);
}

/** 保存した配信者URLを消す(--reset。次の起動で聞き直す) */
export function forgetBroadcastUrl(): void {
  const saved = readSaved();
  delete saved.broadcastUrl;
  if (Object.keys(saved).length === 0) rmSync(configFile(), { force: true });
  else writeSaved(saved);
}

/**
 * 席の識別子。同じPCは再起動しても同じ席に戻るよう、初回に作って保存する。
 * 環境変数 PUBLISHER_ID があればそちらを使う(開発で複数のブリッジを動かすとき)
 */
function publisherId(saved: SavedConfig): string {
  const fromEnv = process.env.PUBLISHER_ID;
  if (fromEnv && PID_PATTERN.test(fromEnv)) return fromEnv;
  if (saved.pid && PID_PATTERN.test(saved.pid)) return saved.pid;
  const pid = `pc-${randomBytes(4).toString('hex')}`;
  writeSaved({ ...saved, pid });
  return pid;
}

/**
 * 配信者URLを Worker の URL・ルーム・キーに分ける。
 * 短縮形(/broadcast/…)は Worker が broadcast.html?key=…&room=… へ飛ばすので、その飛び先を読む
 */
export async function resolveBroadcastUrl(
  input: string,
): Promise<{ origin: string; room: string; key: string }> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('URLの形になっていません(https:// から始まる配信者URLを貼ってください)');
  }
  if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') {
    throw new Error('https:// のURLを使ってください');
  }

  if (!url.pathname.endsWith('/broadcast.html')) {
    const res = await fetch(url, { redirect: 'manual' });
    const location = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && location) {
      url = new URL(location, url);
    } else if (res.status === 404) {
      throw new Error('このURLは使えません(ルームが閉じられて、URLが新しくなったかもしれません)');
    } else if (res.status === 403) {
      // Worker はルームが開いていないとき、閉鎖のお知らせのページを 403 で返す
      throw new Error('ルームが閉じています。運営者にルームを開いてもらってください');
    } else if (res.ok) {
      // 飛び先の無いふつうのページ(視聴ページ・管理画面など)
      throw new Error(
        '配信者URLではないようです(管理画面の「配信者URLを表示する」を押して出るURLを貼ってください)',
      );
    } else {
      throw new Error(`URLを確かめられませんでした(HTTP ${res.status})`);
    }
  }
  const key = url.searchParams.get('key') ?? '';
  const room = url.searchParams.get('room') ?? 'main';
  if (!key) {
    throw new Error(
      '配信者URLではないようです(視聴URLではなく、管理画面の「配信者URLを表示する」を押して出るURLを貼ってください)',
    );
  }
  if (!ROOM_PATTERN.test(room)) throw new Error(`ルーム名が正しくありません: ${room}`);
  return { origin: url.origin, room, key };
}

/** 配信者キーが通るかを Worker に聞く(配信者だけが見られる一覧を取ってみる) */
async function checkKey(origin: string, room: string, key: string): Promise<void> {
  const res = await fetch(`${origin}/api/sfu/publisher?room=${encodeURIComponent(room)}`, {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (res.status === 403) {
    throw new Error('配信者キーが通りませんでした(ルームが閉じられて、URLが新しくなったかもしれません)');
  }
  if (!res.ok) throw new Error(`配信先に接続できませんでした(HTTP ${res.status})`);
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

/** 設定を決める。配信者URLが無く、聞くこともできなければ例外 */
/** 保存した配信者URLがあるか(デスクトップアプリが、最初に URL の欄を出すかを決める) */
export function hasSavedBroadcastUrl(): boolean {
  return Boolean(readSaved().broadcastUrl);
}

/** 保存した配信者URLから設定を作る(無ければ null。URL が使えなくなっていたら例外) */
export async function savedWorkerSettings(): Promise<WorkerSettings | null> {
  const saved = readSaved();
  if (!saved.broadcastUrl) return null;
  const resolved = await resolveBroadcastUrl(saved.broadcastUrl);
  await checkKey(resolved.origin, resolved.room, resolved.key);
  return { mode: 'worker', ...resolved, pid: publisherId(saved) };
}

/** 配信者URLを確かめてから保存し、設定を返す(デスクトップアプリの URL の欄から) */
export async function saveBroadcastUrl(input: string): Promise<WorkerSettings> {
  const resolved = await resolveBroadcastUrl(input);
  await checkKey(resolved.origin, resolved.room, resolved.key);
  writeSaved({ ...readSaved(), broadcastUrl: input.trim() });
  return { mode: 'worker', ...resolved, pid: publisherId(readSaved()) };
}

export async function loadSettings(): Promise<BridgeSettings> {
  if (process.argv.includes('--reset')) {
    forgetBroadcastUrl();
    console.log('[設定] 保存していた配信者URLを消しました');
  }
  const saved = readSaved();
  const given = argValue('--url') ?? process.env.BROADCAST_URL;

  // 1. 起動時に渡されたURL / 保存済みのURL
  const candidate = given ?? saved.broadcastUrl;
  if (candidate) {
    const resolved = await resolveBroadcastUrl(candidate);
    await checkKey(resolved.origin, resolved.room, resolved.key);
    if (given && given !== saved.broadcastUrl) {
      writeSaved({ ...readSaved(), broadcastUrl: given });
      console.log(`[設定] 配信者URLを保存しました(${configFile()})`);
    }
    return { mode: 'worker', ...resolved, pid: publisherId(saved) };
  }

  // 2. 開発用: リポジトリの .env の App Secret で SFU を直接使う
  const appId = process.env.CF_REALTIME_APP_ID;
  const appSecret = process.env.CF_REALTIME_APP_SECRET;
  if (appId && appSecret) {
    const room = ROOM_PATTERN.test(process.env.ROOM ?? '') ? String(process.env.ROOM) : 'main';
    return {
      mode: 'direct',
      appId,
      appSecret,
      viewerOrigin: process.env.VIEWER_ORIGIN ?? null,
      bridgeToken: process.env.BRIDGE_TOKEN ?? null,
      room,
      // 従来どおり、名乗らなければ 'default' の席(SETUP.md 3-4)
      pid: PID_PATTERN.test(process.env.PUBLISHER_ID ?? '') ? String(process.env.PUBLISHER_ID) : 'default',
    };
  }

  // 3. 初回: コンソールで配信者URLを聞いて保存する(正しいURLが入るまで聞き直す)
  if (!process.stdin.isTTY) {
    throw new Error('配信者URLがありません。--url <配信者URL> を付けて起動してください');
  }
  console.log('');
  console.log('はじめに、運営者から受け取った「配信者URL」を貼り付けて Enter を押してください。');
  console.log('(右クリックで貼り付けられます。URLはこのPCに保存され、次からは聞きません)');
  for (;;) {
    const input = (await ask('配信者URL> ')).trim();
    if (!input) continue;
    try {
      const resolved = await resolveBroadcastUrl(input);
      await checkKey(resolved.origin, resolved.room, resolved.key);
      writeSaved({ ...readSaved(), broadcastUrl: input });
      console.log(`[設定] 配信者URLを保存しました(ルーム: ${resolved.room})`);
      return { mode: 'worker', ...resolved, pid: publisherId(readSaved()) };
    } catch (error) {
      console.log(`  → ${error instanceof Error ? error.message : String(error)}。もう一度貼ってください`);
    }
  }
}
