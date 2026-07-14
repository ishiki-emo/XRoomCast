/**
 * 配信者コンソール(音声)。
 * マイクをOpus音声トラックとしてCloudflare Realtime SFUへパブリッシュし、
 * セッションIDをWorkerに登録する(BROADCAST_KEYによるBearer認証)。
 * 手順は cloudflare/calls-examples の echo に準拠:
 * sessions/new(空) → addTransceiver+offer → tracks/new(local) → answer適用。
 */
const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const TRACK_NAME = 'mic';
const HEARTBEAT_MS = 4 * 60 * 1000;

const statusEl = document.getElementById('b-status') as HTMLDivElement;
const toggleButton = document.getElementById('b-toggle') as HTMLButtonElement;

const key = new URLSearchParams(location.search).get('key') ?? '';

function setStatus(text: string, kind: 'idle' | 'live' | 'error' = 'idle'): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('live', kind === 'live');
  statusEl.classList.toggle('error', kind === 'error');
}

async function api(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(path, {
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
toggleButton.addEventListener('click', () => {
  toggleButton.disabled = true;
  const task = live ? stop() : start();
  task
    .then(() => {
      live = !live;
      toggleButton.textContent = live ? 'マイク配信を停止' : 'マイク配信を開始';
      toggleButton.classList.toggle('live', live);
    })
    .catch((error) => {
      void stop(true).finally(() => setStatus(`エラー: ${String(error)}`, 'error'));
      live = false;
      toggleButton.textContent = 'マイク配信を開始';
      toggleButton.classList.remove('live');
    })
    .finally(() => {
      toggleButton.disabled = false;
    });
});

// タブを閉じるときに登録解除を試みる(失敗しても15分で自動失効)
window.addEventListener('pagehide', () => {
  if (sessionId) {
    navigator.sendBeacon?.(
      '/api/sfu/audio-publisher-beacon?key=' + encodeURIComponent(key),
      JSON.stringify({ sessionId: null }),
    );
  }
});

if (!key) {
  setStatus('URLにキーがありません(/broadcast/<キー> から開いてください)', 'error');
  toggleButton.disabled = true;
}
