/**
 * 配信者コンソール(音声)。
 * マイクをOpus音声トラックとしてCloudflare Realtime SFUへパブリッシュし、
 * セッションIDをWorkerに登録する(BROADCAST_KEYによるBearer認証)。
 * 手順は cloudflare/calls-examples の echo に準拠:
 * sessions/new(空) → addTransceiver+offer → tracks/new(local) → answer適用。
 */
import { setupAvatarConsole } from './avatarConsole';
import { setupBroadcastPreview, type PreviewHandle, type XrMode } from './broadcastPreview';
import { withAuth } from '@xroomcast/sync';
import { createAuth } from './auth';
import { readConfig, sameOriginWebSocketUrl, type RoomSettings } from './config';
import { setupRoomSettings } from './roomSettings';
import { setupStageConsole } from './stageConsole';
import { withRoom } from '@xroomcast/sync';
import { PRESET_EXPRESSIONS, defaultGestureSettings } from './gestureExpressions';
import { DEFAULT_WRIST_OFFSET, HmdBroadcast, setWristOffset } from './hmdBroadcast';
import { GESTURE_INFO } from './vrGestures';
import { RECORD_SECONDS, WebcamBroadcast } from './webcamBroadcast';
import type { PeerState } from '@xroomcast/viewer-core';

// 表情の候補(Webカメラの表情登録とHMDのジェスチャーで共有)。ページの初期化はモジュールの読み込み中に
// 走る(下の setupPreview)ので、そこから使う定数はここで先に用意しておく
/** 割り当て先にしない表情(口・まばたき・視線は推定や他の仕組みで動かすため) */
const RESERVED_EXPRESSIONS = new Set([
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'blink',
  'blinkLeft',
  'blinkRight',
  'lookUp',
  'lookDown',
  'lookLeft',
  'lookRight',
  'neutral',
]);
const EXPRESSION_LABELS: Record<string, string> = {
  happy: 'happy(喜)',
  angry: 'angry(怒)',
  sad: 'sad(哀)',
  relaxed: 'relaxed(楽)',
  surprised: 'surprised(驚)',
};
const expressionLabel = (name: string) => EXPRESSION_LABELS[name] ?? name;

/** アバターの表情から、割り当て先に選べるもの(アバターが未読み込みなら標準の5つ) */
function usableExpressions(names: readonly string[]): string[] {
  const usable = names.filter((name) => !RESERVED_EXPRESSIONS.has(name));
  return usable.length > 0 ? usable : [...PRESET_EXPRESSIONS];
}

const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const TRACK_NAME = 'mic';
const HEARTBEAT_MS = 4 * 60 * 1000;

const statusEl = document.getElementById('b-status') as HTMLDivElement;
const toggleButton = document.getElementById('b-toggle') as HTMLButtonElement;
/** 声を届ける席(複数配信者用)。配信中は変更できないようにする */
const micSlotSelect = document.getElementById('m-slot') as HTMLSelectElement | null;
/** 配信者名(pid)。席の割り当てと「自動(自分の席)」解決の鍵 */
const pidInput = document.getElementById('b-pid') as HTMLInputElement | null;
const PID_STORAGE_KEY = 'xroomcast.pid';
const PID_PATTERN = /^[A-Za-z0-9_-]{1,32}$/;

function sanitizePid(value: string): string | null {
  const trimmed = value.trim();
  return PID_PATTERN.test(trimmed) ? trimmed : null;
}

// 初期値: URLの ?pid= > 前回使った名前 > 'default'(=ブリッジの既定と同じ)
if (pidInput) {
  const fromUrl = sanitizePid(new URLSearchParams(location.search).get('pid') ?? '');
  const fromStorage = sanitizePid(localStorage.getItem(PID_STORAGE_KEY) ?? '');
  pidInput.value = fromUrl ?? fromStorage ?? 'default';
  localStorage.setItem(PID_STORAGE_KEY, pidInput.value);
  pidInput.addEventListener('change', () => {
    const pid = sanitizePid(pidInput.value);
    if (pid) localStorage.setItem(PID_STORAGE_KEY, pid);
  });
}

/** いまの配信者名(不正な入力は 'default' 扱い) */
function currentPid(): string {
  return (pidInput ? sanitizePid(pidInput.value) : null) ?? 'default';
}

/** 自分のpidの席をサーバーの配信者一覧から引く(配信元が居なければnull) */
/** ルームの配信元(pidと席)の一覧。取れなければnull */
async function fetchPublishers(): Promise<{ pid: string; slot: number }[] | null> {
  try {
    const res = await fetch(withAuth('/api/sfu/publisher', config.room, auth));
    if (!res.ok) return null;
    const data = (await res.json()) as { publishers?: { pid: string; slot: number }[] };
    return data.publishers ?? [];
  } catch {
    return null;
  }
}

async function fetchOwnSlot(): Promise<number | null> {
  return (await fetchPublishers())?.find((p) => p.pid === currentPid())?.slot ?? null;
}

/**
 * 自分の配信元がまだ居ないときに、アバター設定を当てておく席。
 * 席0が空いていれば席0(配信を始めると最小の空き席=席0を得るため)。
 * 埋まっていれば、どの席になるか分からないのでnull(手動で選んでもらう)
 */
async function fetchVacantSlot(): Promise<number | null> {
  const publishers = await fetchPublishers();
  if (!publishers) return null;
  return publishers.some((p) => p.slot === 0) ? null : 0;
}

/** マイク配信中の席(配信中は固定する)と、自動解決の状態メモ */
let activeMicSlot = 0;
let micSeatNote = '';

/**
 * マイクの席を決める。「自動」は自分(配信者名)の配信元の席。
 * まだ配信元が居ないときは席0へ流しておき、HMD配信の開始後に合わせ直す
 * (HMDは「マイク開始 → ポーズ配信の登録」の順序で、開始時点では席が無いため)
 */
async function resolveMicSlot(): Promise<number> {
  micSeatNote = '';
  const value = micSlotSelect?.value ?? 'auto';
  if (value !== 'auto') return Number(value) || 0;
  const slot = await fetchOwnSlot();
  if (slot === null) {
    micSeatNote = '・自分の席が未確定のため席0';
    return 0;
  }
  return slot;
}

function micLiveStatus(): string {
  return `🔴 音声配信中(席${activeMicSlot}${micSeatNote}。このタブを閉じると停止します)`;
}

/**
 * 鏡(プレビュー)が映す席。アバター欄で操作中の席に追従する。
 * pidの解決結果ではなく「操作中の席」を使うのが要点——自分の配信元が
 * まだ登録されていなくても、席を手動で選んで作業している人の鏡は
 * その席を映すべきなので
 */
let mirrorSlot = 0;
/** 鏡の読み直し。setupPreview が実体を入れる */
let refreshMirror: (() => void) | null = null;

function setMirrorSlot(slot: number | null): void {
  const next = slot ?? 0;
  if (next === mirrorSlot) return;
  mirrorSlot = next;
  refreshMirror?.();
}

/**
 * 自動選択のまま席がずれていたら登録を移す。
 * HMD配信の開始でポーズ配信元(pid)が席を得た直後に呼ぶ
 */
async function realignMicSeat(): Promise<void> {
  if (!live || micSlotSelect?.value !== 'auto') return;
  const slot = await fetchOwnSlot();
  if (slot === null || slot === activeMicSlot) return;
  const previous = activeMicSlot;
  activeMicSlot = slot;
  micSeatNote = '';
  try {
    await api('/api/sfu/audio-publisher', { sessionId: null, slot: previous });
    await register();
    setStatus(micLiveStatus(), 'live');
  } catch {
    // 失敗しても次のハートビートで現在の席へ登録される
  }
}

const config = readConfig();
const key = config.broadcastKey;
const auth = createAuth(config);

function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', kind === 'live');
  statusEl.classList.toggle('error', kind === 'error');
}

async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(withRoom(path, config.room), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await auth.headers()) },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
  return data;
}

let pc: RTCPeerConnection | null = null;
let stream: MediaStream | null = null;
let sessionId: string | null = null;
/** 送信中のトラックを差し替えるための送信者。セッションを作り直さないために保つ */
let sender: RTCRtpSender | null = null;
let heartbeatTimer: number | null = null;
/** マイクの取得・解放の通知(プレビューの鏡の口を動かす)。setupPreview が入れる */
let onMicTrack: ((track: MediaStreamTrack | null) => void) | null = null;

async function acquireMic(): Promise<MediaStreamTrack> {
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('マイクが見つかりません');
  onMicTrack?.(track);
  return track;
}

/** マイクのデバイスを解放する(録音インジケータを消すため、停止時は必ず呼ぶ) */
function releaseMic(): void {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  onMicTrack?.(null);
}

function startHeartbeat(): void {
  if (heartbeatTimer !== null) window.clearInterval(heartbeatTimer);
  heartbeatTimer = window.setInterval(() => void register(), HEARTBEAT_MS);
}

/** セッションごと破棄する(接続が壊れたときと、タブを閉じるとき) */
function teardown(): void {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  releaseMic();
  pc?.close();
  pc = null;
  sender = null;
  sessionId = null;
}

/**
 * マイク配信の開始。
 *
 * **2回目以降はセッションを作り直さない。** 作り直すと配信セッションIDが変わり、
 * 視聴側は新しいIDを購読し直すことになる。古いトラックのトランシーバは
 * 閉じられないまま残るため、ON/OFFのたびに視聴側へ積み上がっていく
 * (先頭を拾うと死んだトラックを掴んで無音になる、という不具合の温床でもあった)。
 * セッションと送信者を保ったまま、送るトラックだけを差し替える。
 */
async function start(): Promise<void> {
  setStatus('声の席を確認中...');
  activeMicSlot = await resolveMicSlot();
  setStatus('マイクを取得中...');
  const track = await acquireMic();

  if (pc && sender && sessionId) {
    try {
      await sender.replaceTrack(track);
      await register();
      startHeartbeat();
      setStatus(micLiveStatus(), 'live');
      return;
    } catch (error) {
      // 再利用できなければ作り直す(セッションが失効している場合など)
      console.warn('[broadcast] 既存セッションの再利用に失敗。作り直します:', error);
      teardown();
      await createSession(await acquireMic());
      return;
    }
  }
  await createSession(track);
}

async function createSession(track: MediaStreamTrack): Promise<void> {
  setStatus('SFUセッションを作成中...');
  pc = new RTCPeerConnection({ iceServers: [{ urls: CF_STUN_URL }], bundlePolicy: 'max-bundle' });

  // 状態表示。ハンドラ登録前に接続が完了する場合があるため、関数化して最後にも呼ぶ
  const connection = pc;
  const updateConnectionStatus = (): void => {
    if (pc !== connection) return;
    if (connection.connectionState === 'connected') {
      setStatus(micLiveStatus(), 'live');
    } else if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
      // 壊れた接続を再利用しないよう捨てる(次の開始で作り直される)
      teardown();
      markMic(false);
      setStatus(`WebRTC接続が${connection.connectionState}になりました。もう一度開始してください`, 'error');
    }
  };
  connection.onconnectionstatechange = updateConnectionStatus;

  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });
  sender = transceiver.sender;

  const session = await api('/api/sfu/sessions/new', {});
  sessionId = String(session.sessionId);

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  const result = await api('/api/sfu/tracks/new', {
    sessionId,
    sessionDescription: { type: 'offer', sdp: offer.sdp },
    tracks: [{ location: 'local', mid: transceiver.mid, trackName: TRACK_NAME }],
  });
  const answer = result.sessionDescription as { type: 'answer'; sdp: string } | undefined;
  if (!answer) throw new Error('SFUからanswerが返りませんでした');
  await pc.setRemoteDescription(answer);

  await register();
  startHeartbeat();

  setStatus('接続中...', 'live');
  updateConnectionStatus();
}

async function register(): Promise<void> {
  if (!sessionId) return;
  await api('/api/sfu/audio-publisher', { sessionId, trackName: TRACK_NAME, slot: activeMicSlot });
}

/**
 * マイク配信の停止。
 * **セッションは残したまま**送信トラックだけ外す(再開時に作り直さないため)。
 * マイクのデバイスは解放するので、ブラウザの録音インジケータは消える。
 * セッションごと畳むのはタブを閉じるときと接続が壊れたときだけ
 */
async function stop(silent = false): Promise<void> {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    await api('/api/sfu/audio-publisher', { sessionId: null, slot: activeMicSlot });
  } catch {
    // 登録解除の失敗は無視(15分で自動失効する)
  }
  try {
    await sender?.replaceTrack(null);
  } catch {
    // 外せなくてもマイクは解放するので送信は止まる
  }
  releaseMic();
  if (!silent) setStatus('停止しました');
}

let live = false;

function markMic(on: boolean): void {
  live = on;
  toggleButton.textContent = on ? 'マイク配信を停止' : 'マイク配信を開始';
  toggleButton.classList.toggle('live', on);
  // 配信中に席や名前を変えると旧席の登録が残るため、停止するまで固定する
  if (micSlotSelect) micSlotSelect.disabled = on;
  if (pidInput) pidInput.disabled = on;
}

/** マイク配信の開始/停止。HMD配信の開始時にも使う */
async function setMicLive(on: boolean): Promise<void> {
  if (on === live) return;
  try {
    await (on ? start() : stop());
    markMic(on);
  } catch (error) {
    void stop(true).finally(() => setStatus(`エラー: ${String(error)}`, 'error'));
    markMic(false);
    throw error;
  }
}

toggleButton.addEventListener('click', () => {
  toggleButton.disabled = true;
  setMicLive(!live)
    .catch(() => {
      // エラー表示は setMicLive 側で済んでいる
    })
    .finally(() => {
      toggleButton.disabled = false;
    });
});

// ---- 退室(自分の席を空ける) ----
// マイクを止め、配信元の登録を解除する。席の持ち物(アバター・音声)は
// サーバー側で片付く。ブリッジが動いたままだとハートビートで席を取り直す
// ため、ブリッジ利用時は先にブリッジを止めてもらう(注記に記載)
const leaveButton = document.getElementById('b-leave') as HTMLButtonElement | null;
leaveButton?.addEventListener('click', () => {
  if (!window.confirm(`「${currentPid()}」として退室しますか?(席とアバターが片付きます)`)) {
    return;
  }
  leaveButton.disabled = true;
  void (async () => {
    try {
      if (live) await setMicLive(false);
      const result = (await api('/api/sfu/publisher', {
        sessionId: null,
        pid: currentPid(),
      })) as { left?: number | null };
      setStatus(
        typeof result.left === 'number'
          ? `退室しました(席${result.left}を空けました)`
          : '退室しました(この名前の配信元は登録されていませんでした)',
      );
    } catch (error) {
      setStatus(`退室に失敗: ${String(error)}`, 'error');
    } finally {
      leaveButton.disabled = false;
    }
  })();
});

// タブを閉じるときに登録解除を試みる(失敗しても15分で自動失効)。
// ここではセッションごと畳む(停止ボタンと違い、再開の余地がないため)
window.addEventListener('pagehide', () => {
  if (sessionId) {
    // sendBeaconはヘッダを付けられないので資格情報はクエリで運ぶ
    navigator.sendBeacon?.(
      withAuth('/api/sfu/audio-publisher-beacon', config.room, auth),
      JSON.stringify({ sessionId: null, slot: activeMicSlot }),
    );
    teardown();
  }
});

const TAB_STORAGE_KEY = 'xroomcast.broadcast.tab';

/**
 * 設定欄(アバター/ステージ/ルーム設定/共有)のタブ。開いていたタブは次回も開く。
 * 保存できない環境(プライベートウィンドウ等)でも先頭のタブで動く
 */
function setupTabs(): void {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('[data-tab]')];
  const panels = [...document.querySelectorAll<HTMLElement>('[data-panel]')];
  const select = (name: string): void => {
    for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.tab === name));
    for (const panel of panels) panel.hidden = panel.dataset.panel !== name;
    try {
      localStorage.setItem(TAB_STORAGE_KEY, name);
    } catch {
      // 覚えられないだけ
    }
  };
  for (const tab of tabs) tab.addEventListener('click', () => select(tab.dataset.tab!));
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(TAB_STORAGE_KEY);
  } catch {
    // 既定のタブで開く
  }
  select(tabs.some((tab) => tab.dataset.tab === saved) ? saved! : tabs[0]!.dataset.tab!);
}

/**
 * 手首の向きの微調整。
 * コントローラのグリップ姿勢とVRMのTポーズの手の対応は端末によって
 * ずれることがあるため、画面から詰められるようにしている
 * (HMDを被っている最中はPCのコンソールを触れないので、値は保存して使い回す)
 */
function setupWristTuner(preview?: PreviewHandle): void {
  const row = document.getElementById('wrist-row') as HTMLElement;
  const labels: Record<'x' | 'y' | 'z', HTMLElement> = {
    x: document.getElementById('wrist-x') as HTMLElement,
    y: document.getElementById('wrist-y') as HTMLElement,
    z: document.getElementById('wrist-z') as HTMLElement,
  };
  const STORAGE_KEY = 'xroomcast.wristOffset';
  const STEP = 15;
  const angles = { ...DEFAULT_WRIST_OFFSET };

  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null') as typeof angles | null;
    if (saved) Object.assign(angles, saved);
  } catch {
    // 壊れていたら既定値のまま
  }

  const apply = (): void => {
    setWristOffset(angles.x, angles.y, angles.z);
    for (const axis of ['x', 'y', 'z'] as const) {
      labels[axis].textContent = `${angles[axis]}°`;
    }
    // HMD中は画面が見えないので、空間パネルの見出しにも現在値を出す
    preview?.setWristLabel(`手首 X${angles.x} Y${angles.y} Z${angles.z}`);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(angles));
    } catch {
      // 保存できなくても動作には影響しない
    }
  };

  const step = (axis: 'x' | 'y' | 'z', delta: number): void => {
    angles[axis] = ((angles[axis] + delta + 540) % 360) - 180;
    apply();
  };
  if (preview) preview.onWristChange = step;

  for (const button of row.querySelectorAll<HTMLButtonElement>('[data-wrist]')) {
    button.addEventListener('click', () => {
      const action = button.dataset.wrist ?? '';
      if (action === 'reset') {
        Object.assign(angles, DEFAULT_WRIST_OFFSET);
        apply();
      } else {
        step(action[0] as 'x' | 'y' | 'z', action.endsWith('+') ? STEP : -STEP);
      }
    });
  }
  apply();
  row.hidden = false;
}

// 不具合報告のときに「どのバージョンを動かしているか」が分かるように出す
const versionLabel = document.getElementById('app-version');
if (versionLabel) versionLabel.textContent = `XRoomCast v${__APP_VERSION__}`;

setupTabs();

const roomLabel = document.getElementById('b-room');
if (roomLabel) {
  roomLabel.textContent = `ルーム「${config.room}」の配信者コンソールです`;
}

if (!key) {
  setStatus('URLにキーがありません(/broadcast/<キー> から開いてください)', 'error');
  toggleButton.disabled = true;
} else {
  setupAvatarConsole({
    room: config.room,
    auth,
    resolveOwnSlot: fetchOwnSlot,
    resolveVacantSlot: fetchVacantSlot,
    onSeatChanged: setMirrorSlot,
  });
  setupStageConsole({ room: config.room, auth });
  setupPreview();
}

/** マイクの使用が許可済みか(確かめられないブラウザでは false = 先に許可を取る) */
async function micPermissionGranted(): Promise<boolean> {
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state === 'granted';
  } catch {
    return false;
  }
}

/**
 * HMD配信のジェスチャーと表情(VRChat準拠)。ジェスチャーごとに、左右の手それぞれの表情を割り当てる。
 * 割り当てはこの端末のブラウザにだけ保存する(HMDのブラウザで配信するなら、HMDのブラウザで設定する)
 */
function setupGestureSettings(hmd: HmdBroadcast): { setExpressions(names: string[]): void } {
  const table = document.getElementById('g-table') as HTMLTableSectionElement;
  const reset = document.getElementById('g-reset') as HTMLButtonElement;
  let expressions: string[] = [...PRESET_EXPRESSIONS];

  const render = (): void => {
    const settings = hmd.gestureSettings;
    table.replaceChildren(
      ...GESTURE_INFO.map(({ gesture, label, howTo }) => {
        const row = document.createElement('tr');
        const name = document.createElement('td');
        name.textContent = label;
        name.title = `コントローラ: ${howTo}`;
        row.append(name);
        for (const side of ['left', 'right'] as const) {
          const cell = document.createElement('td');
          const select = document.createElement('select');
          const current = settings[side][gesture] ?? '';
          // アバターに無い表情が割り当てられていても、消さずに選択肢に残す
          const names = current && !expressions.includes(current) ? [...expressions, current] : expressions;
          select.append(
            new Option('(なし)', '', false, current === ''),
            ...names.map((n) => new Option(expressionLabel(n), n, false, n === current)),
          );
          select.addEventListener('change', () => {
            const next = {
              left: { ...hmd.gestureSettings.left },
              right: { ...hmd.gestureSettings.right },
            };
            next[side][gesture] = select.value || null;
            hmd.setGestureSettings(next);
          });
          cell.append(select);
          row.append(cell);
        }
        return row;
      }),
    );
  };
  reset.addEventListener('click', () => {
    hmd.setGestureSettings(defaultGestureSettings());
    render();
  });
  render();
  return {
    setExpressions: (names) => {
      expressions = usableExpressions(names);
      render();
    },
  };
}

/**
 * Webカメラ配信の個人設定(このブラウザにだけ保存)。滑らかさ・手の推定のオン/オフ・
 * 普通の顔の登録・表情の型の登録(この顔 → VRMのこの表情)・書き出しと読み込み
 */
function setupWebcamSettings(webcam: WebcamBroadcast): { setExpressions(names: string[]): void } {
  const panel = document.getElementById('p-webcam-settings') as HTMLElement;
  const smooth = document.getElementById('w-smooth') as HTMLInputElement;
  const hands = document.getElementById('w-hands') as HTMLInputElement;
  const neutralButton = document.getElementById('w-neutral') as HTMLButtonElement;
  const neutralState = document.getElementById('w-neutral-state') as HTMLElement;
  const neutralClear = document.getElementById('w-neutral-clear') as HTMLButtonElement;
  const target = document.getElementById('w-target') as HTMLSelectElement;
  const addButton = document.getElementById('w-add') as HTMLButtonElement;
  const list = document.getElementById('w-templates') as HTMLUListElement;
  const message = document.getElementById('w-message') as HTMLElement;
  const exportButton = document.getElementById('w-export') as HTMLButtonElement;
  const importButton = document.getElementById('w-import') as HTMLButtonElement;
  const importFile = document.getElementById('w-import-file') as HTMLInputElement;

  const label = expressionLabel;
  const setExpressions = (names: string[]): void => {
    const previous = target.value;
    target.replaceChildren(
      ...usableExpressions(names).map((name) => new Option(label(name), name, false, name === previous)),
    );
  };
  setExpressions([]);

  const meters: HTMLElement[] = [];
  const renderTemplates = (): void => {
    const settings = webcam.currentSettings;
    meters.length = 0;
    list.replaceChildren(
      ...settings.templates.map((template, i) => {
        const li = document.createElement('li');
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = `${i + 1}. → ${label(template.target)}`;
        const meter = document.createElement('span');
        meter.className = 'meter';
        const bar = document.createElement('span');
        meter.append(bar);
        meters.push(bar);
        const remove = document.createElement('button');
        remove.className = 'small';
        remove.textContent = '削除';
        remove.addEventListener('click', () => {
          webcam.removeTemplate(i);
          render();
        });
        li.append(name, meter, remove);
        return li;
      }),
    );
  };

  const render = (): void => {
    const settings = webcam.currentSettings;
    smooth.value = String(settings.smoothing);
    hands.checked = settings.hands;
    neutralState.textContent = settings.neutral ? '登録済み' : '未登録';
    neutralClear.hidden = !settings.neutral;
    const canRecord = webcam.active && !webcam.isRecording;
    neutralButton.disabled = !canRecord;
    addButton.disabled = !canRecord;
    renderTemplates();
  };
  panel.addEventListener('webcam-state', render);

  // 型ごとの出かたを、登録した一覧に棒で出す(どの顔がどの型に効いているかを確かめられる)
  window.setInterval(() => {
    if (panel.hidden || !webcam.active) return;
    webcam.liveTemplateWeights.forEach((weight, i) => {
      const bar = meters[i];
      if (bar) bar.style.width = `${Math.round(weight * 100)}%`;
    });
  }, 150);

  smooth.addEventListener('input', () => webcam.setSmoothing(Number(smooth.value)));
  hands.addEventListener('change', () => webcam.setHands(hands.checked));

  /** 数秒の顔を撮る。撮っている間はボタンに残り秒数を出す */
  const record = (button: HTMLButtonElement, targetName: string | null, done: string): void => {
    const original = button.textContent;
    const started = performance.now();
    const timer = window.setInterval(() => {
      const left = Math.max(0, RECORD_SECONDS - (performance.now() - started) / 1000);
      button.textContent = `その顔のまま… ${left.toFixed(1)}秒`;
    }, 100);
    message.textContent = '';
    neutralButton.disabled = addButton.disabled = true;
    webcam
      .record(targetName)
      .then(() => (message.textContent = done))
      .catch((error: unknown) => {
        message.textContent = String(error instanceof Error ? error.message : error);
      })
      .finally(() => {
        window.clearInterval(timer);
        button.textContent = original;
        render();
      });
  };
  neutralButton.addEventListener('click', () =>
    record(neutralButton, null, '普通の顔を登録しました。まばたきや口の誤反応が減ります'),
  );
  neutralClear.addEventListener('click', () => {
    webcam.clearNeutral();
    render();
  });
  addButton.addEventListener('click', () =>
    record(addButton, target.value, `「${label(target.value)}」の顔を登録しました`),
  );

  exportButton.addEventListener('click', () => {
    const blob = new Blob([webcam.exportSettings()], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'xroomcast-webcam-settings.json';
    link.click();
    URL.revokeObjectURL(link.href);
  });
  importButton.addEventListener('click', () => importFile.click());
  importFile.addEventListener('change', () => {
    const file = importFile.files?.[0];
    importFile.value = '';
    if (!file) return;
    void file
      .text()
      .then((text) => {
        webcam.importSettings(text);
        message.textContent = '設定を読み込みました';
      })
      .catch(
        () => (message.textContent = '読み込めませんでした(書き出したファイルを選んでください)'),
      )
      .finally(render);
  });

  render();
  return { setExpressions };
}

/**
 * Webカメラ配信(VSeeFace・ブリッジ・HMDなし)。HMD配信と同じく、マイクも一緒に始める
 * (配信者が「声が出ていない」ことに気づきにくいため)
 */
function setupWebcam(webcam: WebcamBroadcast, statusEl: HTMLElement, preview: PreviewHandle): void {
  // 配信中はプレビューに手元の動きを直接映す(届いた姿は通信の遅れでもたついて見える)
  preview.setLocalPose(() => webcam.localFrame());
  const button = document.getElementById('p-webcam') as HTMLButtonElement;
  const recalibrate = document.getElementById('p-webcam-recal') as HTMLButtonElement;
  const video = document.getElementById('p-webcam-video') as HTMLVideoElement;
  // カメラを使えない環境(httpや古いブラウザ)では出さない
  if (!navigator.mediaDevices?.getUserMedia) return;
  button.hidden = false;
  const settingsPanel = document.getElementById('p-webcam-settings') as HTMLElement;
  settingsPanel.hidden = false;
  const render = (): void => {
    settingsPanel.dispatchEvent(new Event('webcam-state'));
    button.textContent = webcam.active ? '⏹ Webカメラ配信を止める' : '📷 Webカメラで配信';
    button.classList.toggle('danger', webcam.active);
    recalibrate.hidden = !webcam.active;
    video.hidden = !webcam.active;
  };
  button.addEventListener('click', () => {
    if (webcam.active) {
      webcam.stop();
      render();
      return;
    }
    button.disabled = true;
    setMicLive(true)
      .catch(() => {
        statusEl.textContent = 'マイクを開始できませんでした(そのまま配信します)';
      })
      .then(() => webcam.start(video))
      // ポーズ配信の登録で席が決まったので、マイクの「自動」を自分の席へ合わせ直す
      .then(() => realignMicSeat())
      .catch((error: unknown) => {
        webcam.stop();
        statusEl.textContent = `Webカメラ配信を開始できませんでした: ${String(error)}`;
      })
      .finally(() => {
        button.disabled = false;
        render();
      });
  });
  recalibrate.addEventListener('click', () => webcam.recalibrate());
  render();
}

/**
 * 3Dプレビューと視聴者の気配。
 * 配信者として Presence WebSocket に繋ぐ(キーはWorker側で検証される)
 */
function setupPreview(): void {
  const previewStatus = document.getElementById('p-status') as HTMLElement;
  const hmdBroadcast = new HmdBroadcast(config.room, auth, currentPid);
  hmdBroadcast.onStatus = (text) => (previewStatus.textContent = text);
  const webcamBroadcast = new WebcamBroadcast(config.room, auth, currentPid);
  webcamBroadcast.onStatus = (text) => (previewStatus.textContent = text);
  const webcamSettings = setupWebcamSettings(webcamBroadcast);
  const gestureSettings = setupGestureSettings(hmdBroadcast);

  const preview = setupBroadcastPreview({
    canvas: document.getElementById('p-canvas') as HTMLCanvasElement,
    statusEl: previewStatus,
    room: config.room,
    auth,
    broadcast: hmdBroadcast,
    onAvatarLoaded: ({ height, expressions }) => {
      webcamBroadcast.setAvatarHeight(height);
      webcamSettings.setExpressions(expressions);
      gestureSettings.setExpressions(expressions);
    },
  });
  onMicTrack = (track) => preview.setMicTrack(track);
  const liveTrack = stream?.getAudioTracks()[0];
  if (liveTrack) preview.setMicTrack(liveTrack);

  // HMD配信(対応端末でのみボタンを出す)。パススルーと没入VRを選べる
  const arButton = document.getElementById('p-hmd-ar') as HTMLButtonElement;
  const vrButton = document.getElementById('p-hmd-vr') as HTMLButtonElement;
  const hmdNote = document.getElementById('p-hmd-note') as HTMLElement;
  void preview.hmdSupported.then(({ ar, vr }) => {
    arButton.hidden = !ar;
    vrButton.hidden = !vr;
    hmdNote.hidden = !ar && !vr;
    (document.getElementById('p-gesture-settings') as HTMLElement).hidden = !ar && !vr;
  });

  const enter = (mode: XrMode, button: HTMLButtonElement): void => {
    button.disabled = true;
    // HMDに入ると画面のボタンを押せなくなるので、マイクもここで入れる(音声とポーズは別経路)。
    // マイクの許可が済んでいれば、マイクの開始(音声の接続)はVRに入るのと並行して進める。
    // 許可がまだなら、許可の確認がVRの裏に隠れないよう、先にマイクを始めてから入る
    const startMic = () =>
      setMicLive(true)
        .catch(() => {
          previewStatus.textContent = 'マイクを開始できませんでした(そのまま配信します)';
        })
        .then(() => preview.setMicLabel(live));
    void micPermissionGranted()
      .then(async (granted) => {
        const mic = granted ? startMic() : await startMic();
        await preview.enterHmd(mode);
        await mic;
        // ポーズ配信の登録で席が決まってから、マイクの「自動」を自分の席へ合わせ直す
        await hmdBroadcast.connecting;
        await realignMicSeat();
      })
      .catch((error: unknown) => {
        previewStatus.textContent = `HMD配信を開始できませんでした: ${String(error)}`;
      })
      .finally(() => {
        button.disabled = false;
      });
  };
  arButton.addEventListener('click', () => enter('ar', arButton));
  vrButton.addEventListener('click', () => enter('vr', vrButton));

  setupWebcam(webcamBroadcast, previewStatus, preview);

  // 空間パネルからのマイク操作を画面側と同期させる
  preview.onMicToggle = () => {
    void setMicLive(!live).finally(() => preview.setMicLabel(live));
  };

  // 鏡(自分の姿)の表示切り替え。視聴者と重なるときに消せる
  const mirrorButton = document.getElementById('p-mirror') as HTMLButtonElement;
  void preview.hmdSupported.then((supported) => (mirrorButton.hidden = !supported));
  let mirrorOn = true;
  mirrorButton.addEventListener('click', () => {
    mirrorOn = !mirrorOn;
    preview.setMirrorVisible(mirrorOn);
    mirrorButton.classList.toggle('on', mirrorOn);
    mirrorButton.textContent = mirrorOn ? '🪞 鏡を表示' : '🪞 鏡は非表示';
  });

  setupWristTuner(preview);

  // 気配の公開範囲もルーム設定の一部として、まとめてこちらが受け持つ
  const roomSettings = setupRoomSettings({ room: config.room, auth });

  const connect = (): void => {
    const path = withAuth('/api/presence', config.room, auth);
    const ws = new WebSocket(sameOriginWebSocketUrl(path));
    let pingTimer: number | null = null;
    ws.onopen = () => {
      pingTimer = window.setInterval(() => ws.send('ping'), 30000);
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as PeerState & {
          type?: string;
          id?: string;
          url?: string;
          settings?: RoomSettings;
        };
        if (data.type === 'peer' && data.id) preview.applyPeer(data.id, data);
        else if (data.type === 'peerLeft' && data.id) preview.removePeer(data.id);
        // 別のコンソールから変更された場合もこちらへ反映される
        else if (data.type === 'settings' && data.settings) roomSettings.apply(data.settings);
        else if (data.type === 'avatar' && data.url) {
          /**
           * 鏡に映すのは**操作中の席のアバターだけ**。席を見ずに反映すると、
           * 他の配信者がアバターを変えるたびに全員の鏡が揃ってしまう
           */
          const messageSlot = typeof (data as { slot?: number }).slot === 'number'
            ? (data as { slot: number }).slot
            : 0;
          if (messageSlot === mirrorSlot) preview.setAvatarUrl(data.url);
        }
      } catch {
        // pong等は無視
      }
    };
    ws.onclose = () => {
      if (pingTimer !== null) window.clearInterval(pingTimer);
      preview.clearPeers();
      window.setTimeout(connect, 5000);
    };
  };
  connect();

  /** 鏡を操作中の席のアバターに合わせて読み直す(初期表示と席の切り替え時) */
  const syncMirrorAvatar = async (): Promise<void> => {
    try {
      const res = await fetch(withAuth('/api/avatar', config.room, auth));
      const data = (await res.json()) as {
        avatar?: { url?: string } | null;
        avatars?: Record<string, { url?: string } | undefined>;
      };
      const record = data.avatars?.[String(mirrorSlot)] ?? (mirrorSlot === 0 ? data.avatar : null);
      if (record?.url) preview.setAvatarUrl(record.url);
      else preview.setStatus(`席${mirrorSlot}はアバター未設定です(下の一覧から切り替えてください)`);
    } catch {
      preview.setStatus('アバターの取得に失敗しました');
    }
  };
  refreshMirror = () => void syncMirrorAvatar();
  void syncMirrorAvatar();
}
