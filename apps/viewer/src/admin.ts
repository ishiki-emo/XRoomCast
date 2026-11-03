/**
 * 運営者の管理画面(/admin)。
 *
 * - コメント機能の許可(サービス全体)。既定は許可しない
 * - ルームの一覧(配信中か・視聴者数・設定・使っているアバターとステージ)
 * - ルームにアップロードされたVRM・ステージモデルの削除
 *
 * 入り方は2つ。**Cloudflare Access で /admin と /api/admin を保護してログインする**(推奨。
 * URLに鍵が載らない)か、予備の管理者キーで /admin/<キー> から開く(Worker の ADMIN_KEY)。
 * どちらも配信者キーとは別物。APIは /api/admin/*
 */
import type { RoomSettings, StageState } from './config';

interface RoomStatus {
  room: string;
  viewers?: number;
  consoles?: number;
  publishers?: { pid: string; slot: number; updatedAt: number }[];
  settings?: RoomSettings;
  avatars?: Record<string, { key: string; name: string }>;
  stage?: StageState;
  error?: string;
}

interface FileItem {
  key: string;
  size: number;
  uploaded: number;
}

const REFRESH_MS = 15000;

const KEY_STORAGE_KEY = 'xroomcast.admin.key';

/** URLのキー。消したあとの再読み込みでも使えるよう、このタブの間だけ覚えておく */
function readKey(): string {
  const fromUrl = new URLSearchParams(location.search).get('key');
  try {
    if (fromUrl) sessionStorage.setItem(KEY_STORAGE_KEY, fromUrl);
    return fromUrl ?? sessionStorage.getItem(KEY_STORAGE_KEY) ?? '';
  } catch {
    return fromUrl ?? '';
  }
}

const key = readKey();
// キーをアドレスバーと履歴に残さない(画面共有や後ろからの覗き見で漏れないように)
history.replaceState(null, '', location.pathname);

const statusEl = document.getElementById('status') as HTMLDivElement;
const policyEl = document.getElementById('c-policy') as HTMLDivElement;
const allowButton = document.getElementById('c-allow') as HTMLButtonElement;
const denyButton = document.getElementById('c-deny') as HTMLButtonElement;
const roomsEl = document.getElementById('rooms') as HTMLDivElement;
const emptyEl = document.getElementById('r-empty') as HTMLParagraphElement;
const reloadButton = document.getElementById('r-reload') as HTMLButtonElement;
const updatedEl = document.getElementById('r-updated') as HTMLSpanElement;
const versionEl = document.getElementById('app-version');
if (versionEl) versionEl.textContent = `XRoomCast v${__APP_VERSION__}`;

/** ファイル一覧を開いているルーム(更新しても開いたままにする) */
const openFiles = new Set<string>();
let latestRooms: RoomStatus[] = [];

function setStatus(text: string, error = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', error);
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      // Accessでログインしていれば、認証はCookieに載って届く(キーは要らない)
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `${path} が失敗 (${res.status})`);
  return data;
}

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
    : `${Math.ceil(bytes / 1024)} KB`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text; // textContentなのでルーム名等は無害化される
  return element;
}

function renderPolicy(allowed: boolean): void {
  policyEl.textContent = allowed
    ? '許可しています(各ルームで配信者がオンにできます)'
    : '許可していません(どのルームでもコメントは使えません)';
  policyEl.className = `policy ${allowed ? 'on' : 'off'}`;
  allowButton.classList.toggle('on', allowed);
  denyButton.classList.toggle('on', !allowed);
}

/** そのファイルを使っている席・ステージ */
function usageOf(room: RoomStatus, fileKey: string): string[] {
  const uses: string[] = [];
  for (const [slot, avatar] of Object.entries(room.avatars ?? {})) {
    if (avatar.key === fileKey) uses.push(`席${slot}のアバター`);
  }
  if (room.stage?.source === 'model' && room.stage.key === fileKey) uses.push('ステージ');
  return uses;
}

async function renderFiles(room: RoomStatus, list: HTMLUListElement): Promise<void> {
  list.replaceChildren(el('li', 'empty', '読み込み中...'));
  try {
    const { items } = await api<{ items: FileItem[] }>(
      `/api/admin/files?room=${encodeURIComponent(room.room)}`,
    );
    list.replaceChildren();
    if (items.length === 0) list.append(el('li', 'empty', 'ファイルはありません'));
    for (const item of items) {
      const li = el('li');
      const relative = item.key.slice(`rooms/${room.room}/`.length);
      const kind = relative.startsWith('stage/') ? '🎪' : '🧍';
      li.append(el('span', 'name', `${kind} ${relative}`));
      li.append(el('span', 'size', formatSize(item.size)));
      const uses = usageOf(room, item.key);
      if (uses.length > 0) li.append(el('span', 'used', `使用中: ${uses.join('・')}`));
      const remove = el('button', 'danger', '削除');
      remove.addEventListener('click', () => {
        const warning =
          uses.length > 0 ? `\n\n使用中です(${uses.join('・')})。削除すると外れます。` : '';
        if (!confirm(`「${relative}」を削除しますか？元に戻せません。${warning}`)) return;
        remove.disabled = true;
        void api('/api/admin/files/delete', {
          method: 'POST',
          body: JSON.stringify({ key: item.key }),
        })
          .then(() => refresh())
          .catch((error: unknown) => {
            remove.disabled = false;
            setStatus(String(error instanceof Error ? error.message : error), true);
          });
      });
      li.append(remove);
      list.append(li);
    }
  } catch (error) {
    list.replaceChildren(el('li', 'empty', `読み込めませんでした: ${String(error)}`));
  }
}

function renderRooms(rooms: RoomStatus[]): void {
  roomsEl.replaceChildren();
  emptyEl.hidden = rooms.length > 0;
  // 配信中のルームを先に、次に視聴者の多い順
  const sorted = [...rooms].sort(
    (a, b) =>
      (b.publishers?.length ?? 0) - (a.publishers?.length ?? 0) ||
      (b.viewers ?? 0) - (a.viewers ?? 0) ||
      a.room.localeCompare(b.room),
  );
  for (const room of sorted) {
    const live = (room.publishers?.length ?? 0) > 0;
    const card = el('div', `room${live ? ' live' : ''}`);
    const head = el('div', 'room-head');
    head.append(el('span', 'room-name', room.room));
    if (live) head.append(el('span', 'badge live', '● 配信中'));
    head.append(el('span', 'badge', `視聴者 ${room.viewers ?? 0}`));
    if (room.consoles) head.append(el('span', 'badge', `配信者コンソール ${room.consoles}`));
    if (room.settings?.chat) head.append(el('span', 'badge chat', 'コメントあり'));
    if (room.settings?.stopped) head.append(el('span', 'badge live', '緊急停止中'));
    card.append(head);

    if (room.error) {
      card.append(el('div', 'room-meta', `状態を取得できませんでした: ${room.error}`));
    } else {
      const meta: string[] = [];
      if (room.publishers?.length) {
        meta.push(`配信元: ${room.publishers.map((p) => `席${p.slot}=${p.pid}`).join(' / ')}`);
      }
      const avatars = Object.entries(room.avatars ?? {});
      meta.push(
        `アバター: ${avatars.length ? avatars.map(([slot, a]) => `席${slot}=${a.name}`).join(' / ') : 'なし'}`,
      );
      const stage = room.stage;
      meta.push(
        `ステージ: ${stage?.source === 'model' ? (stage.name ?? 'モデル') : stage?.source === 'none' ? 'なし' : '組み込みの装飾'}`,
      );
      if (room.settings) {
        const s = room.settings;
        meta.push(
          `視聴: ${s.access === 'invite' ? '招待制' : '誰でも'} / 上限: ${s.capacity ?? '無制限'}`,
        );
      }
      const metaEl = el('div', 'room-meta');
      for (const line of meta) metaEl.append(el('div', undefined, line));
      card.append(metaEl);
    }

    const row = el('div', 'row');
    const filesButton = el(
      'button',
      undefined,
      openFiles.has(room.room) ? 'ファイルを閉じる' : 'ファイル',
    );
    const list = el('ul', 'files');
    list.hidden = !openFiles.has(room.room);
    filesButton.addEventListener('click', () => {
      if (openFiles.has(room.room)) {
        openFiles.delete(room.room);
        list.hidden = true;
        filesButton.textContent = 'ファイル';
      } else {
        openFiles.add(room.room);
        list.hidden = false;
        filesButton.textContent = 'ファイルを閉じる';
        void renderFiles(room, list);
      }
    });
    row.append(filesButton);
    card.append(row, list);
    if (openFiles.has(room.room)) void renderFiles(room, list);
    roomsEl.append(card);
  }
}

async function refresh(): Promise<void> {
  try {
    const data = await api<{
      commentsAllowed: boolean;
      operator?: string | null;
      rooms: RoomStatus[];
    }>('/api/admin/overview');
    renderPolicy(data.commentsAllowed);
    latestRooms = data.rooms;
    renderRooms(latestRooms);
    const live = latestRooms.filter((r) => (r.publishers?.length ?? 0) > 0).length;
    const who = data.operator ? `${data.operator} でログイン中 / ` : '';
    setStatus(`${who}ルーム ${latestRooms.length} 件(配信中 ${live} 件)`);
    updatedEl.textContent = `${new Date().toLocaleTimeString()} 時点`;
  } catch (error) {
    setStatus(String(error instanceof Error ? error.message : error), true);
  }
}

async function setPolicy(allowed: boolean): Promise<void> {
  if (
    allowed &&
    !confirm(
      'コメント機能を許可しますか？\n\n視聴者どうしのコメントは、他人の通信の媒介にあたる場合があります。必要な届出などを済ませている場合だけ許可してください。',
    )
  ) {
    return;
  }
  allowButton.disabled = denyButton.disabled = true;
  try {
    const data = await api<{ commentsAllowed: boolean }>('/api/admin/comments', {
      method: 'POST',
      body: JSON.stringify({ allowed }),
    });
    renderPolicy(data.commentsAllowed);
    await refresh();
  } catch (error) {
    setStatus(String(error instanceof Error ? error.message : error), true);
  } finally {
    allowButton.disabled = denyButton.disabled = false;
  }
}

allowButton.addEventListener('click', () => void setPolicy(true));
denyButton.addEventListener('click', () => void setPolicy(false));
reloadButton.addEventListener('click', () => void refresh());

// キーが無くても試す(Accessでログインしていれば通る)。断られたら理由がそのまま出る
void refresh();
window.setInterval(() => {
  // ファイル一覧を見ている最中に並びが変わらないよう、開いていないときだけ自動更新する
  if (openFiles.size === 0 && document.visibilityState === 'visible') void refresh();
}, REFRESH_MS);
