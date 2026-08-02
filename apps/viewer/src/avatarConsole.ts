/**
 * 配信者コンソールのアバター管理。
 * VRMをルームのR2領域へアップロードし、「切り替え」を押すとWorker経由で
 * Presence Durable Objectへ通知され、視聴中の全員が読み込み直す。
 * (視聴者ごとにダウンロード完了時点で差し替わるため、切り替えは同時ではない)
 */
import { withRoom } from './config';

interface VrmItem {
  key: string;
  name: string;
  size: number;
  uploaded: number;
}

interface ListResponse {
  items?: VrmItem[];
  defaultKey?: string | null;
  error?: string;
}

interface AvatarResponse {
  avatar?: { key: string; name: string; url: string } | null;
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function setupAvatarConsole(options: { room: string; key: string }): void {
  const { room, key } = options;

  const statusEl = document.getElementById('a-status') as HTMLDivElement;
  const fileInput = document.getElementById('a-file') as HTMLInputElement;
  const uploadButton = document.getElementById('a-upload') as HTMLButtonElement;
  const progressEl = document.getElementById('a-progress') as HTMLProgressElement;
  const listEl = document.getElementById('a-list') as HTMLUListElement;
  const emptyEl = document.getElementById('a-empty') as HTMLParagraphElement;
  const defaultButton = document.getElementById('a-default') as HTMLButtonElement;
  const reloadButton = document.getElementById('a-reload') as HTMLButtonElement;

  let currentKey: string | null = null;
  let defaultKey: string | null = null;
  let busy = false;

  function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('live', kind === 'live');
    statusEl.classList.toggle('error', kind === 'error');
  }

  function setBusy(on: boolean): void {
    busy = on;
    uploadButton.disabled = on;
    reloadButton.disabled = on;
    defaultButton.disabled = on;
    for (const button of listEl.querySelectorAll('button')) button.disabled = on;
  }

  async function callJson(
    path: string,
    init: RequestInit = {},
  ): Promise<Record<string, unknown>> {
    const res = await fetch(withRoom(path, room), {
      ...init,
      headers: { ...init.headers, Authorization: `Bearer ${key}` },
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
    return data;
  }

  function render(items: VrmItem[]): void {
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;

    for (const item of items) {
      const li = document.createElement('li');
      li.classList.toggle('current', item.key === currentKey);

      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = item.name;
      li.appendChild(name);

      const size = document.createElement('span');
      size.className = 'size';
      size.textContent = formatSize(item.size);
      li.appendChild(size);

      const switchButton = document.createElement('button');
      switchButton.className = 'small primary';
      switchButton.textContent = item.key === currentKey ? '配信中' : '切り替え';
      switchButton.disabled = item.key === currentKey || busy;
      switchButton.addEventListener('click', () => void switchTo(item.key, item.name));
      li.appendChild(switchButton);

      const deleteButton = document.createElement('button');
      deleteButton.className = 'small danger';
      deleteButton.textContent = '削除';
      deleteButton.disabled = busy;
      deleteButton.addEventListener('click', () => void remove(item.name));
      li.appendChild(deleteButton);

      listEl.appendChild(li);
    }

    defaultButton.hidden = defaultKey === null;
    defaultButton.disabled = busy || defaultKey === currentKey;
    defaultButton.textContent =
      defaultKey === currentKey ? '既定のVRMを配信中' : '既定のVRMに切り替え';
  }

  async function refresh(): Promise<void> {
    try {
      const [listed, current] = await Promise.all([
        callJson('/api/vrm/list') as Promise<ListResponse>,
        callJson('/api/avatar') as Promise<AvatarResponse>,
      ]);
      defaultKey = listed.defaultKey ?? null;
      currentKey = current.avatar?.key ?? null;
      render(listed.items ?? []);
      setStatus(
        currentKey
          ? `配信中のアバター: ${current.avatar?.name ?? currentKey}`
          : 'まだ切り替えていません(視聴者は視聴URLの既定VRMを表示中)',
        currentKey ? 'live' : 'idle',
      );
    } catch (error) {
      setStatus(`一覧の取得に失敗: ${String(error)}`, 'error');
    }
  }

  async function switchTo(vrmKey: string, name: string): Promise<void> {
    setBusy(true);
    setStatus(`「${name}」に切り替えています...`);
    try {
      await callJson('/api/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: vrmKey }),
      });
      currentKey = vrmKey;
      setStatus(`「${name}」に切り替えました(視聴者はDL完了順に反映されます)`, 'live');
    } catch (error) {
      setStatus(`切り替えに失敗: ${String(error)}`, 'error');
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  async function remove(name: string): Promise<void> {
    if (!window.confirm(`「${name}」を削除しますか?`)) return;
    setBusy(true);
    try {
      await callJson(`/api/vrm/delete?name=${encodeURIComponent(name)}`, { method: 'POST' });
      setStatus(`「${name}」を削除しました`);
    } catch (error) {
      setStatus(`削除に失敗: ${String(error)}`, 'error');
    } finally {
      setBusy(false);
      await refresh();
    }
  }

  /** 進捗を出したいので fetch ではなく XHR を使う(fetchは上りの進捗を取れない) */
  function upload(file: File): Promise<void> {
    return new Promise((resolve, reject) => {
      const path = withRoom(`/api/vrm/upload?name=${encodeURIComponent(file.name)}`, room);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.setRequestHeader('Authorization', `Bearer ${key}`);
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.upload.onprogress = (event) => {
        if (!event.lengthComputable) return;
        progressEl.value = (event.loaded / event.total) * 100;
        const mb = (event.loaded / 1024 / 1024).toFixed(1);
        const totalMb = (event.total / 1024 / 1024).toFixed(1);
        setStatus(`アップロード中... ${mb} / ${totalMb} MB`);
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
      setStatus('VRMファイルを選択してください', 'error');
      return;
    }
    if (!file.name.toLowerCase().endsWith('.vrm')) {
      setStatus('拡張子が .vrm のファイルを選んでください', 'error');
      return;
    }
    setBusy(true);
    progressEl.hidden = false;
    progressEl.value = 0;
    upload(file)
      .then(async () => {
        setStatus(`「${file.name}」をアップロードしました`, 'live');
        fileInput.value = '';
        await refresh();
      })
      .catch((error: unknown) => {
        setStatus(`アップロードに失敗: ${String(error)}`, 'error');
      })
      .finally(() => {
        progressEl.hidden = true;
        setBusy(false);
      });
  });

  reloadButton.addEventListener('click', () => void refresh());
  defaultButton.addEventListener('click', () => {
    if (defaultKey) void switchTo(defaultKey, defaultKey);
  });

  void refresh();
}
