/**
 * 配信者コンソールのアバター管理。
 * VRMをルームのR2領域へアップロードし、「切り替え」を押すとWorker経由で
 * Presence Durable Objectへ通知され、視聴中の全員が読み込み直す。
 * (視聴者ごとにダウンロード完了時点で差し替わるため、切り替えは同時ではない)
 */
import type { AuthProvider } from '@xroomcast/sync';
import { withRoom } from '@xroomcast/sync';

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
  /** 席番号 → 現在のアバター(新サーバーのみ。旧サーバーは avatar のみ) */
  avatars?: Record<string, { key: string; name: string; url: string }>;
  error?: string;
}

function formatSize(bytes: number): string {
  if (bytes <= 0) return '';
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function setupAvatarConsole(options: {
  room: string;
  auth: AuthProvider;
  /** 「自動(自分の席)」の解決。自分の配信元が居なければnullを返す */
  resolveOwnSlot?: () => Promise<number | null>;
}): void {
  const { room, auth, resolveOwnSlot } = options;

  const statusEl = document.getElementById('a-status') as HTMLDivElement;
  const fileInput = document.getElementById('a-file') as HTMLInputElement;
  const uploadButton = document.getElementById('a-upload') as HTMLButtonElement;
  const progressEl = document.getElementById('a-progress') as HTMLProgressElement;
  const listEl = document.getElementById('a-list') as HTMLUListElement;
  const emptyEl = document.getElementById('a-empty') as HTMLParagraphElement;
  const defaultButton = document.getElementById('a-default') as HTMLButtonElement;
  const reloadButton = document.getElementById('a-reload') as HTMLButtonElement;
  const slotSelect = document.getElementById('a-slot') as HTMLSelectElement | null;

  /** 操作対象の席。'auto' は自分(配信者名)の配信元の席に追従する */
  let slotChoice: 'auto' | number = slotSelect && slotSelect.value !== 'auto' ? Number(slotSelect.value) || 0 : 'auto';
  /** 「自動」の解決結果(自分の配信元が居なければnull) */
  let autoSlot: number | null = null;
  /** 席番号 → 配信中のVRMキー */
  let currentKeys: Record<string, string> = {};
  let defaultKey: string | null = null;
  let busy = false;
  let lastItems: VrmItem[] = [];

  /** いま操作対象になっている席番号(自動が未解決ならnull) */
  function effectiveSlot(): number | null {
    return slotChoice === 'auto' ? autoSlot : slotChoice;
  }

  /** いま選択中の席の配信中キー */
  function currentKey(): string | null {
    const slot = effectiveSlot();
    return slot === null ? null : (currentKeys[String(slot)] ?? null);
  }

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
      headers: { ...init.headers, ...(await auth.headers()) },
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
    return data;
  }

  function render(items: VrmItem[]): void {
    lastItems = items;
    listEl.replaceChildren();
    emptyEl.hidden = items.length > 0;
    const current = currentKey();

    for (const item of items) {
      const li = document.createElement('li');
      li.classList.toggle('current', item.key === current);

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
      switchButton.textContent = item.key === current ? '配信中' : '切り替え';
      switchButton.disabled = item.key === current || busy;
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
    defaultButton.disabled = busy || defaultKey === current;
    defaultButton.textContent =
      defaultKey === current ? '既定のVRMを配信中' : '既定のVRMに切り替え';
  }

  /** 席の表記(「自動」は解決結果も添える) */
  function seatLabel(): string {
    if (slotChoice === 'auto') {
      return autoSlot === null ? '自分の席(未確定)' : `自分の席(席${autoSlot})`;
    }
    return `席${slotChoice}`;
  }

  /** いま選択中の席の状態をステータス行へ出す */
  function reportCurrent(): void {
    const slot = effectiveSlot();
    if (slot === null) {
      setStatus(
        '自分の席が未確定です(ブリッジ/HMD配信を開始すると決まります。先に選ぶ場合は席番号を手動で)',
      );
      return;
    }
    const key = currentKey();
    if (key) {
      const name = key.slice(key.lastIndexOf('/') + 1);
      setStatus(`${seatLabel()}: 配信中のアバター: ${name}`, 'live');
    } else if (slot === 0) {
      setStatus('まだ切り替えていません(視聴者は視聴URLの既定VRMを表示中)');
    } else {
      setStatus(`${seatLabel()}はまだアバター未設定です`);
    }
  }

  async function refresh(): Promise<void> {
    try {
      const [listed, current, resolved] = await Promise.all([
        callJson('/api/vrm/list') as Promise<ListResponse>,
        callJson('/api/avatar') as Promise<AvatarResponse>,
        resolveOwnSlot ? resolveOwnSlot() : Promise.resolve(null),
      ]);
      defaultKey = listed.defaultKey ?? null;
      autoSlot = resolved;
      currentKeys = {};
      // 旧サーバーは avatar(席0)だけを返す
      if (current.avatar?.key) currentKeys['0'] = current.avatar.key;
      for (const [slotKey, record] of Object.entries(current.avatars ?? {})) {
        if (record?.key) currentKeys[slotKey] = record.key;
      }
      render(listed.items ?? []);
      reportCurrent();
    } catch (error) {
      setStatus(`一覧の取得に失敗: ${String(error)}`, 'error');
    }
  }

  async function switchTo(vrmKey: string, name: string): Promise<void> {
    setBusy(true);
    try {
      let slot = effectiveSlot();
      if (slot === null && resolveOwnSlot) {
        autoSlot = await resolveOwnSlot();
        slot = effectiveSlot();
      }
      if (slot === null) {
        setStatus(
          '自分の席が見つかりません。ブリッジ/HMD配信を開始するか、席番号を手動で選んでください',
          'error',
        );
        return;
      }
      setStatus(`${seatLabel()}を「${name}」に切り替えています...`);
      await callJson('/api/avatar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: vrmKey, slot }),
      });
      currentKeys[String(slot)] = vrmKey;
      setStatus(`${seatLabel()}を「${name}」に切り替えました(視聴者はDL完了順に反映されます)`, 'live');
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
  async function upload(file: File): Promise<void> {
    // XHRのヘッダは同期的に積むため、資格情報は open の前に解決しておく
    const authHeaders = await auth.headers();
    return new Promise((resolve, reject) => {
      const path = withRoom(`/api/vrm/upload?name=${encodeURIComponent(file.name)}`, room);
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      for (const [name, value] of Object.entries(authHeaders)) xhr.setRequestHeader(name, value);
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
  // 席の切り替えは表示の対象を変えるだけ(一覧は共通なので取得し直さない)。
  // 「自動」へ戻したときだけ解決し直す
  slotSelect?.addEventListener('change', () => {
    if (slotSelect.value === 'auto') {
      slotChoice = 'auto';
      void (resolveOwnSlot ? resolveOwnSlot() : Promise.resolve(null)).then((resolved) => {
        autoSlot = resolved;
        render(lastItems);
        reportCurrent();
      });
      return;
    }
    slotChoice = Number(slotSelect.value) || 0;
    render(lastItems);
    reportCurrent();
  });

  void refresh();
}
