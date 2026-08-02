/**
 * 配信者コンソール(音声)。
 * マイクをOpus音声トラックとしてCloudflare Realtime SFUへパブリッシュし、
 * セッションIDをWorkerに登録する(BROADCAST_KEYによるBearer認証)。
 * 手順は cloudflare/calls-examples の echo に準拠:
 * sessions/new(空) → addTransceiver+offer → tracks/new(local) → answer適用。
 */
import { setupAvatarConsole } from './avatarConsole';
import { setupBroadcastPreview, type PreviewHandle, type XrMode } from './broadcastPreview';
import { readConfig, withRoom } from './config';
import { DEFAULT_WRIST_OFFSET, HmdBroadcast, setWristOffset } from './hmdBroadcast';
import type { PeerState } from './peers';

const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const TRACK_NAME = 'mic';
const HEARTBEAT_MS = 4 * 60 * 1000;

const statusEl = document.getElementById('b-status') as HTMLDivElement;
const toggleButton = document.getElementById('b-toggle') as HTMLButtonElement;

const config = readConfig();
const key = config.broadcastKey;

function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', kind === 'live');
  statusEl.classList.toggle('error', kind === 'error');
}

async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(withRoom(path, config.room), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
  return data;
}

let pc: RTCPeerConnection | null = null;
let stream: MediaStream | null = null;
let sessionId: string | null = null;
let heartbeatTimer: number | null = null;

async function start(): Promise<void> {
  setStatus('マイクを取得中...');
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const track = stream.getAudioTracks()[0];
  if (!track) throw new Error('マイクが見つかりません');

  setStatus('SFUセッションを作成中...');
  pc = new RTCPeerConnection({ iceServers: [{ urls: CF_STUN_URL }], bundlePolicy: 'max-bundle' });

  // 状態表示。ハンドラ登録前に接続が完了する場合があるため、関数化して最後にも呼ぶ
  const connection = pc;
  const updateConnectionStatus = (): void => {
    if (pc !== connection) return;
    if (connection.connectionState === 'connected') {
      setStatus('🔴 音声配信中(このタブを閉じると停止します)', 'live');
    } else if (connection.connectionState === 'failed' || connection.connectionState === 'disconnected') {
      setStatus(`WebRTC接続が${connection.connectionState}になりました。停止して再開してください`, 'error');
    }
  };
  connection.onconnectionstatechange = updateConnectionStatus;

  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' });

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
  heartbeatTimer = window.setInterval(() => void register(), HEARTBEAT_MS);

  setStatus('接続中...', 'live');
  updateConnectionStatus();
}

async function register(): Promise<void> {
  if (!sessionId) return;
  await api('/api/sfu/audio-publisher', { sessionId, trackName: TRACK_NAME });
}

async function stop(silent = false): Promise<void> {
  if (heartbeatTimer !== null) {
    window.clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  try {
    await api('/api/sfu/audio-publisher', { sessionId: null });
  } catch {
    // 登録解除の失敗は無視(15分で自動失効する)
  }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  pc?.close();
  pc = null;
  sessionId = null;
  if (!silent) setStatus('停止しました');
}

let live = false;

function markMic(on: boolean): void {
  live = on;
  toggleButton.textContent = on ? 'マイク配信を停止' : 'マイク配信を開始';
  toggleButton.classList.toggle('live', on);
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

// タブを閉じるときに登録解除を試みる(失敗しても15分で自動失効)
window.addEventListener('pagehide', () => {
  if (sessionId) {
    navigator.sendBeacon?.(
      withRoom('/api/sfu/audio-publisher-beacon?key=' + encodeURIComponent(key), config.room),
      JSON.stringify({ sessionId: null }),
    );
  }
});

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

const roomLabel = document.getElementById('b-room');
if (roomLabel) {
  roomLabel.textContent = `ルーム「${config.room}」の配信者コンソールです`;
}

if (!key) {
  setStatus('URLにキーがありません(/broadcast/<キー> から開いてください)', 'error');
  toggleButton.disabled = true;
} else {
  setupAvatarConsole({ room: config.room, key });
  setupPreview();
}

/**
 * 3Dプレビューと視聴者の気配。
 * 配信者として Presence WebSocket に繋ぐ(キーはWorker側で検証される)
 */
function setupPreview(): void {
  const previewStatus = document.getElementById('p-status') as HTMLElement;
  const hmdBroadcast = new HmdBroadcast(config.room, key);
  hmdBroadcast.onStatus = (text) => (previewStatus.textContent = text);

  const preview = setupBroadcastPreview({
    canvas: document.getElementById('p-canvas') as HTMLCanvasElement,
    statusEl: previewStatus,
    room: config.room,
    broadcast: hmdBroadcast,
  });

  // HMD配信(対応端末でのみボタンを出す)。パススルーと没入VRを選べる
  const arButton = document.getElementById('p-hmd-ar') as HTMLButtonElement;
  const vrButton = document.getElementById('p-hmd-vr') as HTMLButtonElement;
  const hmdNote = document.getElementById('p-hmd-note') as HTMLElement;
  void preview.hmdSupported.then(({ ar, vr }) => {
    arButton.hidden = !ar;
    vrButton.hidden = !vr;
    hmdNote.hidden = !ar && !vr;
  });

  const enter = (mode: XrMode, button: HTMLButtonElement): void => {
    button.disabled = true;
    // HMDに入ると画面のボタンを押せなくなるので、マイクはここで入れておく。
    // 音声とポーズは別経路で配信されるため同時に成立する
    setMicLive(true)
      .catch(() => {
        previewStatus.textContent = 'マイクを開始できませんでした(そのまま配信します)';
      })
      .then(() => {
        preview.setMicLabel(live);
        return preview.enterHmd(mode);
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

  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('[data-peermode]')];
  const markMode = (mode: string): void => {
    for (const button of modeButtons) {
      button.classList.toggle('on', button.dataset.peermode === mode);
    }
  };
  for (const button of modeButtons) {
    button.addEventListener('click', () => {
      const mode = button.dataset.peermode ?? 'all';
      markMode(mode);
      void fetch(withRoom('/api/peer-mode', config.room), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify({ mode }),
      }).catch(() => setStatus('公開範囲の変更に失敗しました', 'error'));
    });
  }

  const connect = (): void => {
    const path = `${withRoom('/api/presence', config.room)}&key=${encodeURIComponent(key)}`;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
    let pingTimer: number | null = null;
    ws.onopen = () => {
      pingTimer = window.setInterval(() => ws.send('ping'), 30000);
    };
    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(String(event.data)) as PeerState & {
          type?: string;
          id?: string;
          mode?: string;
          url?: string;
        };
        if (data.type === 'peer' && data.id) preview.applyPeer(data.id, data);
        else if (data.type === 'peerLeft' && data.id) preview.removePeer(data.id);
        else if (data.type === 'peerMode' && data.mode) markMode(data.mode);
        else if (data.type === 'avatar' && data.url) preview.setAvatarUrl(data.url);
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
}
