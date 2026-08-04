/**
 * 配信者コンソールのステージ管理。
 *
 * ステージ = アバターの周りに置く飾りと、PC表示の配色。**PCでもARでも出る**
 * (配信の見た目そのものなので)。アバター管理と同じ流れで、R2へアップロードし、
 * 選ぶと接続中の視聴者全員へ即座に配られる。
 *
 * モデルは**アバターの足元が原点・正面が -Z** という約束で作る。
 */
import { withRoom, type AuthProvider } from '@xroomcast/sync';
import type { StageState } from './config';

interface StageItem {
  key: string;
  name: string;
  size: number;
}

/** 視聴者全員がダウンロードするので、アバターより厳しくしている */
const MAX_MB = 10;

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function setupStageConsole(options: { room: string; auth: AuthProvider }): void {
  const { room, auth } = options;

  const statusEl = document.getElementById('st-status') as HTMLDivElement;
  const fileInput = document.getElementById('st-file') as HTMLInputElement;
  const uploadButton = document.getElementById('st-upload') as HTMLButtonElement;
  const listEl = document.getElementById('st-list') as HTMLUListElement;
  const emptyEl = document.getElementById('st-empty') as HTMLParagraphElement;
  const sourceButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-stagesource]')];
  const skyInput = document.getElementById('st-sky') as HTMLInputElement;
  const groundInput = document.getElementById('st-ground') as HTMLInputElement;
  const colorApply = document.getElementById('st-color-apply') as HTMLButtonElement;
  const colorReset = document.getElementById('st-color-reset') as HTMLButtonElement;

  let current: StageState = { source: 'builtin' };

  function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('live', kind === 'live');
    statusEl.classList.toggle('error', kind === 'error');
  }

  function describe(stage: StageState): string {
    if (stage.source === 'none') return 'ステージなし';
    if (stage.source === 'builtin') return '組み込みの装飾';
    return `モデル: ${stage.name ?? '(不明)'}`;
  }

  function render(stage: StageState): void {
    current = stage;
    for (const button of sourceButtons) {
      button.classList.toggle('on', button.dataset.stagesource === stage.source);
    }
    if (document.activeElement !== skyInput) skyInput.value = stage.sky ?? '#f3edff';
    if (document.activeElement !== groundInput) groundInput.value = stage.ground ?? '#fbf8ff';
    for (const li of listEl.querySelectorAll('li')) {
      li.classList.toggle('current', li.dataset.key === stage.key);
    }
    setStatus(describe(stage), stage.source === 'none' ? 'idle' : 'live');
  }

  async function post(body: Record<string, unknown>): Promise<void> {
    try {
      const res = await fetch(withRoom('/api/stage', room), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await auth.headers()) },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { stage?: StageState; error?: string };
      if (!res.ok || !data.stage) throw new Error(data.error ?? `変更に失敗 (${res.status})`);
      render(data.stage);
    } catch (error) {
      setStatus(`ステージの変更に失敗: ${String(error)}`, 'error');
    }
  }

  /** 色は毎回まとめて送る(片方だけ送ると、もう片方が既定へ戻ってしまう) */
  const applyColors = (sky: string | null, ground: string | null): Promise<void> =>
    post({ source: current.source, key: current.key, sky, ground });

  function renderList(items: StageItem[]): void {
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;
    for (const item of items) {
      const li = document.createElement('li');
      li.dataset.key = item.key;
      li.classList.toggle('current', item.key === current.key);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      li.appendChild(name);

      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatSize(item.size);
      li.appendChild(size);

      const use = document.createElement('button');
      use.className = 'small primary';
      use.textContent = item.key === current.key ? '使用中' : '使う';
      use.disabled = item.key === current.key && current.source === 'model';
      use.addEventListener('click', () => {
        void post({ source: 'model', key: item.key, sky: current.sky, ground: current.ground });
      });
      li.appendChild(use);

      const remove = document.createElement('button');
      remove.className = 'small danger';
      remove.textContent = '削除';
      remove.addEventListener('click', () => void deleteItem(item.name));
      li.appendChild(remove);

      listEl.appendChild(li);
    }
  }

  async function refreshList(): Promise<void> {
    try {
      const res = await fetch(withRoom('/api/stage/list', room), {
        headers: await auth.headers(),
      });
      const data = (await res.json()) as { items?: StageItem[]; error?: string };
      if (!res.ok) throw new Error(data.error ?? `一覧の取得に失敗 (${res.status})`);
      renderList(data.items ?? []);
    } catch (error) {
      setStatus(`一覧の取得に失敗: ${String(error)}`, 'error');
    }
  }

  async function deleteItem(name: string): Promise<void> {
    if (!window.confirm(`「${name}」を削除しますか?`)) return;
    try {
      await fetch(withRoom(`/api/stage/delete?name=${encodeURIComponent(name)}`, room), {
        method: 'POST',
        headers: await auth.headers(),
      });
    } finally {
      await refreshList();
    }
  }

  /** 進捗を出したいので fetch ではなく XHR を使う(fetchは上りの進捗を取れない) */
  async function upload(file: File): Promise<void> {
    const headers = await auth.headers();
    return new Promise((resolve, reject) => {
      const path = withRoom(`/api/stage/upload?name=${encodeURIComponent(file.name)}`, room);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        const mb = (event.loaded / 1024 / 1024).toFixed(1);
        const total = (event.total / 1024 / 1024).toFixed(1);
        setStatus(`アップロード中... ${mb} / ${total} MB`);
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let message = `アップロードに失敗 (${xhr.status})`;
        try {
          message = String((JSON.parse(xhr.responseText) as { error?: string }).error ?? message);
        } catch {
          // JSONでない応答はそのまま既定メッセージ
        }
        reject(new Error(message));
      };
      xhr.onerror = () => reject(new Error('ネットワークエラー'));
      xhr.send(file);
    });
  }

  uploadButton.addEventListener('click', () => {
    const file = fileInput.files?.[0];
    if (!file) {
      setStatus('モデルファイルを選択してください', 'error');
      return;
    }
    if (!/\.(glb|gltf)$/i.test(file.name)) {
      setStatus('拡張子が .glb か .gltf のファイルを選んでください', 'error');
      return;
    }
    if (file.size > MAX_MB * 1024 * 1024) {
      setStatus(`${MAX_MB}MB以内にしてください(視聴者全員がダウンロードします)`, 'error');
      return;
    }
    uploadButton.disabled = true;
    upload(file)
      .then(async () => {
        setStatus(`「${file.name}」をアップロードしました`, 'live');
        await refreshList();
      })
      .catch((error) => setStatus(String(error), 'error'))
      .finally(() => {
        uploadButton.disabled = false;
      });
  });

  for (const button of sourceButtons) {
    button.addEventListener('click', () => {
      const source = button.dataset.stagesource;
      if (source === 'model' && !current.key) {
        setStatus('先に一覧から「使う」を押してモデルを選んでください', 'error');
        return;
      }
      void post({ source, key: current.key, sky: current.sky, ground: current.ground });
    });
  }

  colorApply.addEventListener('click', () => void applyColors(skyInput.value, groundInput.value));
  colorReset.addEventListener('click', () => void applyColors(null, null));

  // 起動時に現在の状態を読む
  void (async () => {
    try {
      const res = await fetch(withRoom('/api/stage', room), { headers: await auth.headers() });
      const data = (await res.json()) as { stage?: StageState; error?: string };
      if (!res.ok || !data.stage) throw new Error(data.error ?? `取得に失敗 (${res.status})`);
      render(data.stage);
    } catch (error) {
      setStatus(`ステージの取得に失敗: ${String(error)}`, 'error');
    }
    await refreshList();
  })();
}
