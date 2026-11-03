/**
 * PC配信の中継アプリ(画面つき)。中継の処理は apps/bridge の bridge.ts をそのまま中で動かす。
 *
 * 画面でできること: 配信者URLの貼り付け、状態の表示(VMC の受信・配信・席)、配信の開始と停止、
 * 配信者コンソールを開く(席の名前を入れて開くので、声とアバター設定がこの配信と同じ席になる)。
 * 窓を閉じたら席を空けてから終わる。
 */
import path from 'node:path';
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { connect, disconnect, getStatus, startBridge, VMC_PORT } from '../../bridge/src/bridge.js';
import { consoleUrl } from '../../bridge/src/console.js';
import {
  forgetBroadcastUrl,
  hasSavedBroadcastUrl,
  saveBroadcastUrl,
  savedWorkerSettings,
  type WorkerSettings,
} from '../../bridge/src/settings.js';

// osc-min が古い Buffer() を使っていて、起動のたびに非推奨の警告が出る(動作には関係ない)
process.noDeprecation = true;

let window: BrowserWindow | null = null;
/** いまの配信先(配信を止めていても、URL が決まっていれば持っておく) */
let settings: WorkerSettings | null = null;
let running = false;
/** URL を確かめられなかったときの理由(画面に出す) */
let settingsError: string | null = null;

// ---- ログ: 中継の処理は console に書くので、それを画面へも流す ----
const LOG_LIMIT = 300;
const logs: string[] = [];
for (const level of ['log', 'warn', 'error'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    original(...args);
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    // 毎秒の統計は状態の欄に出しているので、ログには残さない
    if (line.startsWith('[stats]')) return;
    const stamped = `${new Date().toLocaleTimeString('ja-JP')} ${line}`;
    logs.push(stamped);
    if (logs.length > LOG_LIMIT) logs.shift();
    window?.webContents.send('log', stamped);
  };
}

/** 画面に渡す状態。配信者キーは画面に出さない */
function state() {
  return {
    hasUrl: hasSavedBroadcastUrl(),
    room: settings?.room ?? null,
    pid: settings?.pid ?? null,
    origin: settings?.origin ?? null,
    running,
    settingsError,
    vmcPort: VMC_PORT,
    status: getStatus(),
  };
}

async function start(): Promise<void> {
  if (!settings) return;
  await connect(settings);
  running = true;
}

async function stop(): Promise<void> {
  running = false;
  await disconnect();
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

ipcMain.handle('state', () => state());
ipcMain.handle('logs', () => logs);
ipcMain.handle('save-url', async (_event, url: string) => {
  // 失敗したら画面の URL の欄に理由を出す(保存はしない)
  try {
    settings = await saveBroadcastUrl(String(url));
    settingsError = null;
  } catch (error) {
    return { ok: false, error: message(error) };
  }
  await start();
  return { ok: true };
});
ipcMain.handle('forget-url', async () => {
  await stop();
  forgetBroadcastUrl();
  settings = null;
  settingsError = null;
});
ipcMain.handle('start', async () => {
  // 前回 URL を確かめられなかったときは、もう一度確かめてから始める(ルームが開き直されたなど)
  if (!settings) {
    try {
      settings = await savedWorkerSettings();
      settingsError = null;
    } catch (error) {
      settingsError = message(error);
      return;
    }
  }
  await start();
});
ipcMain.handle('stop', () => stop());
ipcMain.handle('open-console', () => {
  if (settings) void shell.openExternal(consoleUrl(settings));
});

function createWindow(): void {
  window = new BrowserWindow({
    width: 520,
    height: 640,
    minWidth: 420,
    minHeight: 480,
    title: 'XRoomCast 中継',
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  void window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  // 画面の中のリンクは既定のブラウザで開く(アプリの窓の中で他のページへ移らない)
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.on('closed', () => (window = null));
}

// 2つ目を起動したら、先に動いている方の窓を前に出す(VMC のポートを取り合わないように)
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.focus();
  });

  void app.whenReady().then(async () => {
    startBridge();
    createWindow();
    // 状態を画面へ流す(VMC の受信数・配信の状態・席)
    setInterval(() => window?.webContents.send('state', state()), 500);
    // URL を保存してあれば、起動したらそのまま配信を始める(コンソール版と同じ)
    if (hasSavedBroadcastUrl()) {
      try {
        settings = await savedWorkerSettings();
        await start();
      } catch (error) {
        settingsError = message(error);
      }
    }
  });

  // 窓を閉じたら、席を空けてから終わる(視聴側に15分残さない)
  let quitting = false;
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    quitting = true;
    void stop().finally(() => app.quit());
  });
}
