/**
 * 運営者の管理画面(/admin)。
 *
 * - コメント機能の許可(サービス全体)。既定は許可しない
 * - ルームの開設・閉鎖と、視聴URL・配信者URL(QR付き)の表示。開設したルームだけが使える
 * - ルームの一覧(配信中か・視聴者数・設定・使っているアバターとステージ)
 * - ルームにアップロードされたVRM・ステージモデルの削除
 *
 * 入り方は2つ。**Cloudflare Access で /admin と /api/admin を保護してログインする**(推奨。
 * URLに鍵が載らない)か、予備の管理者キーで /admin/<キー> から開く(Worker の ADMIN_KEY)。
 * どちらも配信者キーとは別物。APIは /api/admin/*
 */
import qrcode from 'qrcode-generator';
import type { RoomSettings, StageState } from './config';

interface RoomStatus {
  room: string;
  viewers?: number;
  consoles?: number;
  publishers?: { pid: string; slot: number; updatedAt: number }[];
  settings?: RoomSettings;
  avatars?: Record<string, { key: string; name: string }>;
  stage?: StageState;
  /** 台帳。null は未開設 */
  record?: { status: 'open' | 'closed'; gen: number; openedAt: number; closedAt?: number } | null;
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

const newRoomInput = document.getElementById('r-new') as HTMLInputElement;
const openRoomButton = document.getElementById('r-open') as HTMLButtonElement;
const qrStage = document.getElementById('qr-stage') as HTMLDivElement;
const qrStageTitle = document.getElementById('qr-stage-title') as HTMLDivElement;
const qrStageImage = document.getElementById('qr-stage-image') as HTMLDivElement;
const qrStageUrl = document.getElementById('qr-stage-url') as HTMLDivElement;

/** ファイル一覧を開いているルーム(更新しても開いたままにする) */
const openFiles = new Set<string>();
/** URLとQRを開いているルーム */
const openLinks = new Set<string>();
/** ROOM_SECRET があり、ルームのURLを発行できるか */
let canIssueLinks = true;
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

/** QRの画像。誤り訂正はL(模様が粗く、画面越しやHMDのカメラで読みやすい) */
function qrImage(text: string, cellSize: number): HTMLElement {
  const qr = qrcode(0, 'L');
  qr.addData(text);
  qr.make();
  const holder = el('div', 'qr');
  holder.innerHTML = qr.createImgTag(cellSize, 0); // 中身は自前で生成したdata URLの<img>だけ
  return holder;
}

function showQrStage(title: string, text: string, secret: boolean): void {
  qrStageTitle.textContent = title;
  qrStageImage.replaceChildren(qrImage(text, 10));
  // 配信者URLは画面に文字で出さない(QRを映すのは読み取る瞬間だけにする)
  qrStageUrl.textContent = secret ? '' : text;
  qrStage.classList.toggle('secret', secret);
  qrStage.hidden = false;
}

function closeQrStage(): void {
  qrStage.hidden = true;
  qrStageImage.replaceChildren(); // 配信者URLのQRを残さない
}
qrStage.addEventListener('click', closeQrStage);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !qrStage.hidden) closeQrStage();
});

/** ひとつのURL(コピー・小さいQR・全画面QR) */
function linkBlock(label: string, link: string, secret: boolean): HTMLElement {
  const block = el('div', 'link');
  block.append(el('div', secret ? 'link-label secret' : 'link-label', label));
  const row = el('div', 'row');
  const input = el('input');
  input.readOnly = true;
  input.value = link;
  const copy = el('button', undefined, 'コピー');
  copy.addEventListener('click', () => {
    void navigator.clipboard.writeText(link).then(() => {
      copy.textContent = 'コピーしました';
      window.setTimeout(() => (copy.textContent = 'コピー'), 1500);
    });
  });
  const big = el('button', undefined, 'QRを大きく表示');
  big.addEventListener('click', () => showQrStage(label, link, secret));
  row.append(input, copy, big);
  block.append(row);
  if (!secret) block.append(qrImage(link, 3));
  return block;
}

async function renderLinks(room: RoomStatus, panel: HTMLElement): Promise<void> {
  panel.replaceChildren(el('div', 'empty', '読み込み中...'));
  try {
    const links = await api<{ watch: string; broadcast: string }>(
      `/api/admin/rooms/links?room=${encodeURIComponent(room.room)}`,
    );
    panel.replaceChildren(linkBlock('視聴URL(視聴者に配る)', links.watch, false));
    // 配信者URLは配信を操作できる鍵なので、押したときだけ出す
    const reveal = el('button', 'danger', '配信者URLを表示する(配信者だけに渡す鍵)');
    reveal.addEventListener('click', () => {
      reveal.replaceWith(
        linkBlock('配信者URL(配信を操作できる鍵。人に見せない)', links.broadcast, true),
      );
    });
    panel.append(reveal);
  } catch (error) {
    panel.replaceChildren(
      el('div', 'empty', String(error instanceof Error ? error.message : error)),
    );
  }
}

async function changeRoom(room: string, action: 'open' | 'close'): Promise<void> {
  try {
    const result = await api<{ reopened?: boolean }>(`/api/admin/rooms/${action}`, {
      method: 'POST',
      body: JSON.stringify({ room }),
    });
    if (action === 'open')
      openLinks.add(room); // 開設したらそのままURLを見せる
    else openLinks.delete(room);
    await refresh();
    if (result.reopened) setStatus(`ルーム「${room}」を再開設しました(URLは新しくなりました)`);
  } catch (error) {
    setStatus(String(error instanceof Error ? error.message : error), true);
  }
}

function renderRooms(rooms: RoomStatus[]): void {
  roomsEl.replaceChildren();
  emptyEl.hidden = rooms.length > 0;
  // 配信中のルームを先に、次に開設中、視聴者の多い順
  const rank = (r: RoomStatus): number => (r.record?.status === 'open' ? 0 : 1);
  const sorted = [...rooms].sort(
    (a, b) =>
      (b.publishers?.length ?? 0) - (a.publishers?.length ?? 0) ||
      rank(a) - rank(b) ||
      (b.viewers ?? 0) - (a.viewers ?? 0) ||
      a.room.localeCompare(b.room),
  );
  for (const room of sorted) {
    const live = (room.publishers?.length ?? 0) > 0;
    const card = el('div', `room${live ? ' live' : ''}`);
    const head = el('div', 'room-head');
    head.append(el('span', 'room-name', room.room));
    const status = room.record?.status ?? 'none';
    head.append(
      status === 'open'
        ? el('span', 'badge open', '開設中')
        : el('span', 'badge', status === 'closed' ? '閉鎖' : '未開設'),
    );
    if (live) head.append(el('span', 'badge live', '● 配信中'));
    head.append(el('span', 'badge', `視聴者 ${room.viewers ?? 0}`));
    if (room.consoles) head.append(el('span', 'badge', `配信者コンソール ${room.consoles}`));
    if (room.settings?.chat) head.append(el('span', 'badge chat', 'コメントあり'));
    // 閉鎖は内部で停止も立てるので、閉鎖中は重ねて出さない
    if (room.settings?.stopped && status !== 'closed') {
      head.append(el('span', 'badge live', '緊急停止中'));
    }
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
    const linksPanel = el('div', 'links');
    linksPanel.hidden = true;
    if (status === 'open') {
      const linksButton = el(
        'button',
        'primary',
        openLinks.has(room.room) ? 'URLを閉じる' : 'URLとQR',
      );
      linksButton.disabled = !canIssueLinks;
      if (!canIssueLinks) linksButton.title = 'ROOM_SECRET が未設定のため発行できません';
      linksButton.addEventListener('click', () => {
        if (openLinks.has(room.room)) {
          openLinks.delete(room.room);
          linksPanel.hidden = true;
          linksButton.textContent = 'URLとQR';
        } else {
          openLinks.add(room.room);
          linksPanel.hidden = false;
          linksButton.textContent = 'URLを閉じる';
          void renderLinks(room, linksPanel);
        }
      });
      const closeButton = el('button', 'danger', '閉鎖');
      closeButton.addEventListener('click', () => {
        const message =
          `ルーム「${room.room}」を閉鎖しますか？\n\n` +
          '配信・視聴・アップロードができなくなり、接続中の人も切断されます。ファイルは残ります。\n' +
          'もう一度開設すると、視聴URL・配信者URLは新しくなります(今のURLは使えなくなります)。';
        if (confirm(message)) void changeRoom(room.room, 'close');
      });
      row.append(linksButton, filesButton, closeButton);
      if (openLinks.has(room.room) && canIssueLinks) {
        linksPanel.hidden = false;
        void renderLinks(room, linksPanel);
      }
    } else {
      const openButton = el('button', 'primary', status === 'closed' ? '再開設' : '開設');
      openButton.addEventListener('click', () => void changeRoom(room.room, 'open'));
      row.append(openButton, filesButton);
    }
    card.append(row, linksPanel, list);
    if (openFiles.has(room.room)) void renderFiles(room, list);
    roomsEl.append(card);
  }
}

async function refresh(): Promise<void> {
  try {
    const data = await api<{
      commentsAllowed: boolean;
      operator?: string | null;
      canIssueLinks?: boolean;
      rooms: RoomStatus[];
    }>('/api/admin/overview');
    renderPolicy(data.commentsAllowed);
    canIssueLinks = data.canIssueLinks !== false;
    latestRooms = data.rooms;
    renderRooms(latestRooms);
    const live = latestRooms.filter((r) => (r.publishers?.length ?? 0) > 0).length;
    const opened = latestRooms.filter((r) => r.record?.status === 'open').length;
    const who = data.operator ? `${data.operator} でログイン中 / ` : '';
    setStatus(`${who}開設中のルーム ${opened} 件(配信中 ${live} 件)`);
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
openRoomButton.addEventListener('click', () => {
  const room = newRoomInput.value.trim();
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(room)) {
    setStatus('ルーム名は英数字・-・_ の64文字以内にしてください', true);
    return;
  }
  newRoomInput.value = '';
  void changeRoom(room, 'open');
});
newRoomInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) openRoomButton.click();
});

// キーが無くても試す(Accessでログインしていれば通る)。断られたら理由がそのまま出る
void refresh();
window.setInterval(() => {
  // ファイル一覧やURLを見ている最中に並びが変わらないよう、開いていないときだけ自動更新する
  const busy = openFiles.size > 0 || openLinks.size > 0 || !qrStage.hidden;
  if (!busy && document.visibilityState === 'visible') void refresh();
}, REFRESH_MS);
