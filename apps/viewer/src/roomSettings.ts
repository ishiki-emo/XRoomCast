/**
 * 配信者コンソールのルーム設定。
 *
 * 公開配信・非公開配信・イベント会場を別物として作らず、**この設定の
 * 切り替えだけで賄う**のが方針(docs/アーキテクチャ.md)。値はサーバー
 * (Presence Durable Object)が持ち、変更は接続中の全員へ即座に配られる。
 * デプロイし直す必要はない。
 */
import { withRoom, type AuthProvider } from '@xroomcast/sync';
import type { RoomSettings } from './config';

export interface RoomSettingsHandle {
  /** サーバーから押し出された設定を画面へ反映する */
  apply(settings: RoomSettings): void;
}

export function setupRoomSettings(options: {
  room: string;
  auth: AuthProvider;
}): RoomSettingsHandle {
  const { room, auth } = options;

  const statusEl = document.getElementById('s-status') as HTMLDivElement;
  const capacityInput = document.getElementById('s-capacity') as HTMLInputElement;
  const capacityApply = document.getElementById('s-capacity-apply') as HTMLButtonElement;
  const capacityClear = document.getElementById('s-capacity-clear') as HTMLButtonElement;
  const accessButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-access]')];
  const chatButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-chat]')];
  const peerButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-peermode]')];

  let current: RoomSettings | null = null;

  function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('live', kind === 'live');
    statusEl.classList.toggle('error', kind === 'error');
  }

  function describe(settings: RoomSettings): string {
    const access = settings.access === 'invite' ? '招待された人だけ' : '誰でも視聴できます';
    const capacity = settings.capacity === null ? '人数無制限' : `上限 ${settings.capacity} 人`;
    const chat = settings.chat ? 'コメントあり' : 'コメント停止中';
    return `${access} / ${capacity} / ${chat}`;
  }

  function render(settings: RoomSettings): void {
    current = settings;
    for (const button of accessButtons) {
      button.classList.toggle('on', button.dataset.access === settings.access);
    }
    for (const button of chatButtons) {
      button.classList.toggle('on', (button.dataset.chat === 'on') === settings.chat);
    }
    for (const button of peerButtons) {
      button.classList.toggle('on', button.dataset.peermode === settings.peerMode);
    }
    // 入力中の値を上書きしないよう、フォーカスが無いときだけ反映する
    if (document.activeElement !== capacityInput) {
      capacityInput.value = settings.capacity === null ? '' : String(settings.capacity);
    }
    setStatus(describe(settings), settings.access === 'invite' ? 'live' : 'idle');
  }

  async function patch(body: Partial<RoomSettings>): Promise<void> {
    try {
      const res = await fetch(withRoom('/api/room-settings', room), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(await auth.headers()) },
        body: JSON.stringify(body),
      });
      const data = (await res.json()) as { settings?: RoomSettings; error?: string };
      if (!res.ok || !data.settings) throw new Error(data.error ?? `変更に失敗 (${res.status})`);
      render(data.settings);
    } catch (error) {
      setStatus(`設定の変更に失敗: ${String(error)}`, 'error');
      // 失敗したので画面を実際の値へ戻す
      if (current) render(current);
    }
  }

  for (const button of accessButtons) {
    button.addEventListener('click', () => {
      void patch({ access: button.dataset.access === 'invite' ? 'invite' : 'public' });
    });
  }
  for (const button of chatButtons) {
    button.addEventListener('click', () => void patch({ chat: button.dataset.chat === 'on' }));
  }
  for (const button of peerButtons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.peermode;
      void patch({ peerMode: mode === 'broadcaster' || mode === 'off' ? mode : 'all' });
    });
  }
  capacityApply.addEventListener('click', () => {
    const value = Number(capacityInput.value);
    if (!Number.isFinite(value) || value < 1) {
      setStatus('人数は1以上で入力してください', 'error');
      return;
    }
    void patch({ capacity: value });
  });
  capacityClear.addEventListener('click', () => void patch({ capacity: null }));

  // 起動時に現在の値を読む
  void (async () => {
    try {
      const res = await fetch(withRoom('/api/room-settings', room), {
        headers: await auth.headers(),
      });
      const data = (await res.json()) as { settings?: RoomSettings; error?: string };
      if (!res.ok || !data.settings) throw new Error(data.error ?? `取得に失敗 (${res.status})`);
      render(data.settings);
    } catch (error) {
      setStatus(`設定の取得に失敗: ${String(error)}`, 'error');
    }
  })();

  return { apply: render };
}
