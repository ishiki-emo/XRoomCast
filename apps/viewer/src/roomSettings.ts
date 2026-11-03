/**
 * 配信者コンソールのルーム設定。
 *
 * 公開配信・非公開配信・イベント会場を別物として作らず、**この設定の
 * 切り替えだけで賄う**のが方針(docs/アーキテクチャ.md)。値はサーバー
 * (Presence Durable Object)が持ち、変更は接続中の全員へ即座に配られる。
 * デプロイし直す必要はない。
 */
import qrcode from 'qrcode-generator';
import { withRoom, type AuthProvider } from '@xroomcast/sync';
import type { RoomSettings } from './config';

/**
 * QRを作る。型番0(自動選択)。
 * 視聴URLは誤り訂正レベルM: 会場では印刷や画面掲示から読み取られるので、汚れや反射に少し耐える。
 * 配信者URL(Questのカメラでモニタから読む)はL: 模様が粗くなり、離れて読みやすい
 */
function qrImageTag(text: string, cellSize: number, level: 'L' | 'M' = 'M'): string {
  const qr = qrcode(0, level);
  qr.addData(text);
  qr.make();
  return qr.createImgTag(cellSize, 0);
}

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
  const watchUrlInput = document.getElementById('s-watch-url') as HTMLInputElement;
  const watchCopyButton = document.getElementById('s-watch-copy') as HTMLButtonElement;
  const watchOpenButton = document.getElementById('s-watch-open') as HTMLButtonElement;
  const qrEl = document.getElementById('s-qr') as HTMLDivElement;
  const qrBigButton = document.getElementById('s-qr-big') as HTMLButtonElement;
  const qrStage = document.getElementById('qr-stage') as HTMLDivElement;
  const qrStageImage = document.getElementById('qr-stage-image') as HTMLDivElement;
  const qrStageUrl = document.getElementById('qr-stage-url') as HTMLDivElement;
  const qrStageTitle = document.getElementById('qr-stage-title') as HTMLDivElement;
  const hostQrButton = document.getElementById('s-host-qr') as HTMLButtonElement | null;
  const capacityInput = document.getElementById('s-capacity') as HTMLInputElement;
  const capacityApply = document.getElementById('s-capacity-apply') as HTMLButtonElement;
  const capacityClear = document.getElementById('s-capacity-clear') as HTMLButtonElement;
  const accessButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-access]')];
  const chatButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-chat]')];
  const stoppedButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-stopped]')];
  const peerButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-peermode]')];

  let current: RoomSettings | null = null;
  let watchUrlShown: string | null = null;

  /**
   * 視聴URLの表示。**視聴トークンは配信トークンと別の導出**なので、
   * 配信者コンソールが自分で組み立てることはできずサーバーから受け取る
   */
  function showWatchUrl(watchUrl: string | null | undefined): void {
    const available = typeof watchUrl === 'string' && watchUrl.length > 0;
    watchUrlInput.value = available ? watchUrl : '';
    watchUrlInput.placeholder = available
      ? ''
      : 'ROOM_SECRET(または既定ルームのWATCH_KEY)が未設定です';
    watchCopyButton.disabled = !available;
    watchOpenButton.disabled = !available;
    qrBigButton.disabled = !available;
    qrEl.innerHTML = available ? qrImageTag(watchUrl, 3) : '';
    watchUrlShown = available ? watchUrl : null;
  }

  /**
   * 全画面のQR。読み取られる側なので白背景・余白ありにしている。
   * secret(配信者URL)は見出しを赤くし、URLの文字はキーを伏せて出す
   */
  function openQrStage(image: string, title: string, text: string, secret: boolean): void {
    qrStageTitle.textContent = title;
    qrStageImage.innerHTML = image;
    qrStageUrl.textContent = text;
    qrStage.classList.toggle('secret', secret);
    qrStage.hidden = false;
  }
  function closeQrStage(): void {
    qrStage.hidden = true;
    // 配信者URLのQRを画面の裏に残さない
    qrStageImage.innerHTML = '';
  }
  qrBigButton.addEventListener('click', () => {
    // 全画面用は拡大しても粗くならないよう、セルを大きめに描いておく
    if (watchUrlShown) openQrStage(qrImageTag(watchUrlShown, 8), '視聴URL', watchUrlShown, false);
  });
  /**
   * 配信者URL(このページ)のQR。Quest からこのページを開くため。
   * QRはキーを含むので押したときだけ作り、閉じたら消す
   */
  hostQrButton?.addEventListener('click', () => {
    const url = new URL(location.href);
    url.hash = '';
    const masked = new URL(url);
    if (masked.searchParams.has('key')) masked.searchParams.set('key', '••••••');
    openQrStage(
      qrImageTag(url.toString(), 10, 'L'),
      '🔑 配信者URL(Questのカメラで読み取る・配信画面や他人に見せない)',
      decodeURIComponent(masked.toString()),
      true,
    );
  });
  qrStage.addEventListener('click', () => closeQrStage());
  window.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeQrStage();
  });

  watchCopyButton.addEventListener('click', () => {
    const value = watchUrlInput.value;
    if (!value) return;
    // クリップボードAPIが使えない環境(古いブラウザ・非HTTPS)では選択に留める
    void navigator.clipboard?.writeText(value).then(
      () => {
        watchCopyButton.textContent = 'コピーしました';
        window.setTimeout(() => (watchCopyButton.textContent = 'コピー'), 1500);
      },
      () => watchUrlInput.select(),
    );
    if (!navigator.clipboard) watchUrlInput.select();
  });
  watchOpenButton.addEventListener('click', () => {
    if (watchUrlInput.value) window.open(watchUrlInput.value, '_blank', 'noopener');
  });

  function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
    statusEl.textContent = text;
    statusEl.classList.toggle('live', kind === 'live');
    statusEl.classList.toggle('error', kind === 'error');
  }

  function describe(settings: RoomSettings): string {
    if (settings.stopped) return '⏸ 緊急停止中(新規の視聴を断っています)';
    const access = settings.access === 'invite' ? '招待された人だけ' : '誰でも視聴できます';
    const capacity = settings.capacity === null ? '人数無制限' : `上限 ${settings.capacity} 人`;
    const chat = settings.chat ? 'コメントあり' : 'コメントなし';
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
    for (const button of stoppedButtons) {
      button.classList.toggle('on', (button.dataset.stopped === 'on') === settings.stopped);
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
  for (const button of stoppedButtons) {
    button.addEventListener('click', () => void patch({ stopped: button.dataset.stopped === 'on' }));
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
      const data = (await res.json()) as {
        settings?: RoomSettings;
        watchUrl?: string | null;
        error?: string;
      };
      if (!res.ok || !data.settings) throw new Error(data.error ?? `取得に失敗 (${res.status})`);
      showWatchUrl(data.watchUrl);
      render(data.settings);
    } catch (error) {
      setStatus(`設定の取得に失敗: ${String(error)}`, 'error');
    }
  })();

  return { apply: render };
}
