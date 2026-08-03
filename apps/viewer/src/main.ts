import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { decodePacket } from '@xroomcast/protocol';
import { ArController } from './ar';
import { Avatar } from '@xroomcast/viewer-core';
import { withAuth } from '@xroomcast/sync';
import { createAuth } from './auth';
import {
  DEFAULT_VRM_PATH,
  defaultServerUrls,
  readConfig,
  sameOriginWebSocketUrl,
  type TransportKind,
} from './config';
import { ContactShadow, type ShadowMode } from '@xroomcast/viewer-core';
import { DemoController } from './demo';
import { IdleMotion, blendPose } from '@xroomcast/viewer-core';
import { PeerPresence, type PeerDevice, type PeerState } from '@xroomcast/viewer-core';
import { PlaceholderAvatar } from '@xroomcast/viewer-core';
import { SpatialAudio } from '@xroomcast/viewer-core';
import { SpatialChat } from './spatialChat';
import { SpatialPanel } from './spatialUI';
import { setupScenery } from '@xroomcast/viewer-core';
import { PoseStreamPlayer } from '@xroomcast/sync';
import type { Transport } from '@xroomcast/sync';
import { WebSocketTransport } from '@xroomcast/sync';
import { SfuTransport } from '@xroomcast/sync';

// URLクエリの解釈は config.ts に集約している(ルーム・ロール・接続先・VRM)
const config = readConfig();
// 資格情報の取り出しは auth.ts に集約している(差し替え点)
const auth = createAuth(config);
const watchMode = config.watchMode;

const stage = document.getElementById('stage') as HTMLDivElement;
const statsEl = document.getElementById('stats') as HTMLDivElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const urlInput = document.getElementById('vrm-url') as HTMLInputElement;
const loadButton = document.getElementById('load-button') as HTMLButtonElement;

// 視聴モード: 操作UIを隠してページレイアウトに切り替える。
// レンダラのサイズ計算より先にクラスを付けておく必要がある
if (watchMode) document.body.classList.add('watch');

/**
 * 同接カウント・コメントはWorkerが配信しているページでのみ使える。
 * ビルド済みバンドルかどうか(= Workerが配信しているか)で判定する。
 * vite開発サーバーはsrcを直接配信していて接続先が無いので繋ぎにいかない。
 *
 * 以前は `location.protocol === 'https:'` で判定していたが、それだと
 * `wrangler dev`(http://127.0.0.1)でコメントも同接も動かなかった。
 *
 * 視聴モードでなくてもSFUを使うなら繋ぐ。**配信者の音声の開始/停止は
 * presence経由で届く**ため、繋がっていないと音声が一切鳴らなくなる
 */
if (import.meta.env.PROD && (watchMode || config.transport === 'sfu')) {
  window.addEventListener('DOMContentLoaded', () => connectPresence());
}
const demoButton = document.getElementById('demo-button') as HTMLButtonElement;
const dropCheckbox = document.getElementById('drop-checkbox') as HTMLInputElement;
const wsUrlInput = document.getElementById('ws-url') as HTMLInputElement;
const wsButton = document.getElementById('ws-button') as HTMLButtonElement;
const transportSelect = document.getElementById('transport-select') as HTMLSelectElement;

const TRANSPORT_DEFAULT_URLS = defaultServerUrls();

function setStatus(text: string, isError = false): void {
  statusEl.textContent = text;
  statusEl.classList.toggle('error', isError);
}

// 将来のWebXR対応(renderer.xr)を見据えて初期化を分離しておく(仕様書 §9)
function createRenderer(): THREE.WebGLRenderer {
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(stage.clientWidth, stage.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.xr.enabled = true;
  stage.appendChild(renderer.domElement);
  return renderer;
}

const renderer = createRenderer();

const scene = new THREE.Scene();

const camera = new THREE.PerspectiveCamera(
  30,
  stage.clientWidth / Math.max(1, stage.clientHeight),
  0.1,
  50,
);
camera.position.set(0, 1.3, 2.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.update();

// パステル背景・ライティング・浮遊プリミティブ
const scenery = setupScenery(scene);

// アバターの配置フレーム。AR設置・つかみ移動・卓上スケールはこのグループの
// 変換として行う(PoseApplierがフレーム対応なのでIK等は壊れない)
const avatarRoot = new THREE.Group();
scene.add(avatarRoot);

// AR用の接地影(装飾床が消えるARでのみ有効化する)
const contactShadow = new ContactShadow(avatarRoot);

/**
 * AR中のアバターサイズのプリセット。等身大と、卓上に置ける1/10のミニサイズ。
 * ピンチ/両手グリップによる無段階の伸縮とは併用でき、ボタンはそこへジャンプする
 */
const AVATAR_SCALES = { life: 1, mini: 0.1 } as const;
type AvatarSizeMode = keyof typeof AVATAR_SCALES;

// 空間設定パネル(AR中に掴んで置ける)。HMDのようにDOMオーバーレイが
// 使えない端末ではこれが操作手段になるので、設定は1枚にまとめる
const settingsPanel = new SpatialPanel({
  title: '設定',
  sections: [
    {
      title: 'アバター',
      options: [
        { label: '等身大', value: 'life' },
        { label: 'ミニ 1/10', value: 'mini' },
        { label: '置き直す', value: 'replace', action: true },
      ],
      initial: 'life',
      onSelect: (value) => {
        if (value === 'replace') arController.requestPlacement();
        else setAvatarSizeMode(value as AvatarSizeMode);
      },
    },
    {
      title: '影',
      options: [
        { label: 'リアル', value: 'full' },
        { label: 'かんたん(軽量)', value: 'blob' },
        { label: 'なし', value: 'off' },
      ],
      initial: contactShadow.getMode(),
      onSelect: (value) => setShadowMode(value as ShadowMode),
    },
    {
      title: '音声',
      options: [
        { label: '空間(頭から鳴る)', value: 'spatial' },
        { label: '通常', value: 'flat' },
      ],
      initial: 'spatial',
      onSelect: (value) => setSpatialAudio(value === 'spatial'),
    },
    {
      title: '他の視聴者',
      options: [
        { label: '表示する', value: 'peers-on' },
        { label: '隠す', value: 'peers-off' },
      ],
      initial: 'peers-on',
      onSelect: (value) => setPeersVisible(value === 'peers-on'),
    },
  ],
});

// AR空間のコメントフィード(視聴ページのコメントをAR内にも表示)
const spatialChat = new SpatialChat();

// パススルーAR(対応端末でのみボタンが出る)
const arController = new ArController(
  renderer,
  scene,
  avatarRoot,
  [settingsPanel, spatialChat],
  {
    button: document.getElementById('ar-button') as HTMLButtonElement,
    overlayRoot: document.getElementById('ar-overlay') as HTMLElement,
    hint: document.getElementById('ar-hint') as HTMLElement,
    exitButton: document.getElementById('ar-exit') as HTMLButtonElement,
    touch: document.getElementById('ar-touch') as HTMLElement,
  },
  (arActive) => {
    scenery.setARMode(arActive);
    contactShadow.setARActive(arActive);
  },
);
// ピンチ/両手グリップで無段階に変えたときもUIの選択状態を追従させる
arController.onScaleChanged = (scale) => {
  avatar?.applyScale(scale);
  spatialAudio.setAvatarScale(scale);
  syncSizeUi(scale);
};

// ---- AR中のUI(スマホ=画面固定のDOM / HMD=空間パネル) ----
const arControls = document.getElementById('ar-controls') as HTMLElement;
const sizeButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-size]')];
const shadowButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-shadow]')];
const audioButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-audio]')];
const peerButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-peers]')];

/** スケールに最も近いプリセット(離れていればnull=どのボタンも選択されない) */
function nearestSizeMode(scale: number): AvatarSizeMode | null {
  for (const mode of Object.keys(AVATAR_SCALES) as AvatarSizeMode[]) {
    const preset = AVATAR_SCALES[mode];
    if (Math.abs(scale - preset) < preset * 0.15) return mode;
  }
  return null;
}

function syncSizeUi(scale: number): void {
  const mode = nearestSizeMode(scale);
  // ピンチ等でプリセットから外れたら、どのボタンも選択されていない状態にする
  if (mode) settingsPanel.setActive(mode);
  else settingsPanel.clearActive('アバター');
  for (const button of sizeButtons) {
    button.classList.toggle('active', button.dataset.size === mode);
  }
}

function setAvatarSizeMode(mode: AvatarSizeMode): void {
  const scale = AVATAR_SCALES[mode];
  avatarRoot.scale.setScalar(scale);
  avatar?.applyScale(scale);
  spatialAudio.setAvatarScale(scale);
  syncSizeUi(scale);
}

function setShadowMode(mode: ShadowMode): void {
  contactShadow.setMode(mode);
  settingsPanel.setActive(mode);
  for (const button of shadowButtons) {
    button.classList.toggle('active', button.dataset.shadow === mode);
  }
}

for (const button of sizeButtons) {
  // AR中のタップがXRのselect(=アバター設置)として拾われないようにする
  button.addEventListener('beforexrselect', (event) => event.preventDefault());
  button.addEventListener('click', () => setAvatarSizeMode(button.dataset.size as AvatarSizeMode));
}
for (const button of shadowButtons) {
  button.addEventListener('beforexrselect', (event) => event.preventDefault());
  button.addEventListener('click', () => setShadowMode(button.dataset.shadow as ShadowMode));
}

for (const button of audioButtons) {
  button.addEventListener('beforexrselect', (event) => event.preventDefault());
  button.addEventListener('click', () => setSpatialAudio(button.dataset.audio === 'spatial'));
}
for (const button of peerButtons) {
  button.addEventListener('beforexrselect', (event) => event.preventDefault());
  button.addEventListener('click', () => setPeersVisible(button.dataset.peers === 'on'));
}

const replaceButton = document.getElementById('ar-replace') as HTMLButtonElement;
replaceButton.addEventListener('beforexrselect', (event) => event.preventDefault());
replaceButton.addEventListener('click', () => arController.requestPlacement());

// 設定パネルの開閉(項目が増えて視界を塞ぐため、既定は閉じておく)
const settingsToggle = document.getElementById('ar-settings-toggle') as HTMLButtonElement;
settingsToggle.addEventListener('beforexrselect', (event) => event.preventDefault());
settingsToggle.addEventListener('click', () => {
  const open = arControls.hidden;
  arControls.hidden = !open;
  settingsToggle.classList.toggle('active', open);
  settingsToggle.textContent = open ? '✕ 閉じる' : '⚙ 設定';
});

syncSizeUi(avatarRoot.scale.x);
setShadowMode(contactShadow.getMode());

/** 音源位置の計算に使い回すベクトル */
const _headWorld = new THREE.Vector3();

// 他の視聴者の気配。位置はアバター基準の相対座標でやり取りする
const peers = new PeerPresence(avatarRoot);

// ロード中に立てておくクリスタルの仮アバター(ロード成功時に本体と入れ替わる)
const placeholder = new PlaceholderAvatar(avatarRoot);
placeholder.setVisible(false);

let avatar: Avatar | null = null;
let loading = false;

const demo = new DemoController();
let liveTransport: Transport | null = null;
let livePlayer: PoseStreamPlayer | null = null;


// 転送量・描画の統計(視聴モードでステージ下に表示)
const netStats = { bytes: 0, packets: 0, totalBytes: 0, frames: 0 };
let presenceCount: number | null = null;

// 配信停止中オーバーレイ: 最後のポーズパケットから5秒空いたら表示する
const offlineOverlay = document.getElementById('offline-overlay') as HTMLDivElement;
const OFFLINE_AFTER_MS = 5000;
let lastLivePacketAt = 0;
if (watchMode) {
  window.setInterval(() => {
    offlineOverlay.hidden = performance.now() - lastLivePacketAt < OFFLINE_AFTER_MS;
  }, 1000);
}

// ---- 待機モーション ----
// 配信が届いていない間はクライアント側で生成した待機モーションを再生し、
// パケットが来たら配信側を優先する(戻るときもクロスフェードする)
const idleMotion = new IdleMotion();
/** 最後の受信からこの時間が空いたら待機モーションへ移る */
const IDLE_AFTER_MS = OFFLINE_AFTER_MS;
const IDLE_BLEND_MS = 700;
/** 待機↔配信の混ぜ具合(0=待機のみ、1=配信のみ) */
let liveBlend = 0;
/** 完全に配信側へ移行済みか(移行の瞬間だけ待機の表情を片付ける) */
let liveOnly = false;

window.setInterval(() => {
  const kbps = (netStats.bytes / 1024).toFixed(1);
  const total = (netStats.totalBytes / 1024 / 1024).toFixed(2);
  const presence = presenceCount !== null ? `👀 同接 ${presenceCount}人 ・ ` : '';
  // 末尾にバージョンを添える(不具合報告のときにどの版か分かるように)
  statsEl.textContent = `${presence}受信 ${kbps} KB/s ・ ${netStats.packets} pkt/s ・ 累計 ${total} MB ・ 描画 ${netStats.frames} fps ・ v${__APP_VERSION__}`;
  netStats.bytes = 0;
  netStats.packets = 0;
  netStats.frames = 0;
}, 1000);

// ---- 配信者の音声再生(アバターの頭を音源にする空間オーディオ) ----
// 音声付き自動再生はブラウザにブロックされるため、ミュートで待機して
// ボタン(ユーザー操作)でAudioContextを開始+ミュート解除する
const audioButton = document.getElementById('audio-button') as HTMLButtonElement;
const spatialAudio = new SpatialAudio(camera, scene);
let audioMuted = true;
let currentAudioTrack: MediaStreamTrack | null = null;

function handleAudioTrack(track: MediaStreamTrack | null): void {
  currentAudioTrack = track;
  // ボタンの表示を先に決める。再生側で例外が出ても操作手段だけは残す
  audioButton.hidden = track === null;
  spatialAudio.setTrack(track);
  if (!track) return;
  // 配信者側が停止するとリモートトラックはmuteになる(endedは飛んでこない)
  const hideIfCurrent = (): void => {
    if (currentAudioTrack === track) audioButton.hidden = true;
  };
  track.onmute = hideIfCurrent;
  track.onended = hideIfCurrent;
  track.onunmute = () => {
    if (currentAudioTrack === track) audioButton.hidden = false;
  };
}

audioButton.addEventListener('click', () => {
  audioMuted = !audioMuted;
  if (!audioMuted) void spatialAudio.resume();
  spatialAudio.setMuted(audioMuted);
  audioButton.textContent = audioMuted ? '🔇 タップで音声ON' : '🔊 音声ON';
  audioButton.classList.toggle('on', !audioMuted);
});

function setSpatialAudio(on: boolean): void {
  spatialAudio.setSpatial(on);
  const value = on ? 'spatial' : 'flat';
  settingsPanel.setActive(value);
  for (const button of audioButtons) {
    button.classList.toggle('active', button.dataset.audio === value);
  }
}
setSpatialAudio(spatialAudio.isSpatial);

/** 他の視聴者の気配の表示切り替え(隠すと送信も止める) */
function setPeersVisible(on: boolean): void {
  peers.setEnabled(on);
  settingsPanel.setActive(on ? 'peers-on' : 'peers-off');
  for (const button of peerButtons) {
    button.classList.toggle('active', button.dataset.peers === (on ? 'on' : 'off'));
  }
}
setPeersVisible(peers.isEnabled);

// ---- 同接カウント+匿名コメント(Worker上のDurable Object) ----
const chatLog = document.getElementById('chat-log') as HTMLDivElement;
const chatInput = document.getElementById('chat-input') as HTMLInputElement;
const chatSendButton = document.getElementById('chat-send') as HTMLButtonElement;
const CHAT_VISIBLE_MAX = 10;

let presenceWs: WebSocket | null = null;

function appendChat(text: string): void {
  const item = document.createElement('div');
  item.className = 'chat-item';
  item.textContent = text; // textContentで挿入するのでHTMLは無害化される
  chatLog.appendChild(item);
  while (chatLog.children.length > CHAT_VISIBLE_MAX) {
    chatLog.firstChild?.remove();
  }
}

function sendChat(): void {
  const text = chatInput.value.trim();
  if (!text || presenceWs?.readyState !== WebSocket.OPEN) return;
  presenceWs.send(JSON.stringify({ type: 'chat', text }));
  chatInput.value = '';
}

chatSendButton.addEventListener('click', sendChat);
chatInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.isComposing) sendChat();
});

function setChatEnabled(enabled: boolean): void {
  chatInput.disabled = !enabled;
  chatSendButton.disabled = !enabled;
}

interface PresenceMessage extends PeerState {
  type?: string;
  count?: number;
  text?: string;
  items?: { text: string }[];
  /** type==='avatar': 配信者が選んだVRMの配信URL */
  url?: string;
  name?: string;
  /** type==='peer' / 'peerLeft': 送信元の接続ID */
  id?: string;
  /** type==='peerMode': 気配の公開範囲 */
  mode?: string;
  /** type==='audio': 配信者の音声パブリッシャー(停止時はnull) */
  audio?: { sessionId: string; trackName: string } | null;
}

/** 気配の公開範囲(サーバーが決める。配信者コンソールから変更できる) */
let peerMode: 'all' | 'broadcaster' | 'off' = 'all';

// ---- 視聴者の気配の送信 ----
/** 送信レート。動きの少ない対象なので10Hzで足りる */
const PEER_SEND_INTERVAL_MS = 100;
/** 送信量を抑えるため小数点以下3桁に丸める(1mm単位) */
const round3 = (value: number): number => Math.round(value * 1000) / 1000;
let lastPeerSentAt = 0;

const _peerPos = new THREE.Vector3();
const _peerQuat = new THREE.Quaternion();
const _peerScale = new THREE.Vector3();
const _frameInverse = new THREE.Matrix4();

/** ワールド姿勢をアバター基準のローカル姿勢に直して [x,y,z,qx,qy,qz,qw] にする */
function toPeerNode(matrixWorld: THREE.Matrix4): number[] {
  _frameInverse.copy(avatarRoot.matrixWorld).invert().multiply(matrixWorld);
  _frameInverse.decompose(_peerPos, _peerQuat, _peerScale);
  return [
    round3(_peerPos.x),
    round3(_peerPos.y),
    round3(_peerPos.z),
    round3(_peerQuat.x),
    round3(_peerQuat.y),
    round3(_peerQuat.z),
    round3(_peerQuat.w),
  ];
}

function sendPeerState(): void {
  // 「隠す」を選んでいる間と、ルームが無効設定の間は自分の位置も送らない
  if (!peers.isEnabled || peerMode === 'off' || presenceWs?.readyState !== WebSocket.OPEN) return;
  avatarRoot.updateWorldMatrix(true, false);

  const device: PeerDevice = arController.deviceKind;
  // AR中はXRカメラ(=実際の視点)、それ以外は通常のカメラを使う
  const viewCamera = arController.isPresenting ? renderer.xr.getCamera() : camera;
  viewCamera.updateWorldMatrix(true, false);
  const payload: PresenceMessage = { type: 'peer', device, h: toPeerNode(viewCamera.matrixWorld) };

  if (device === 'hmd') {
    const left = arController.getGrip(0);
    const right = arController.getGrip(1);
    if (left) payload.l = toPeerNode(left.matrixWorld);
    if (right) payload.r = toPeerNode(right.matrixWorld);
  }
  presenceWs.send(JSON.stringify(payload));
}

/** 配信者から指示された最後のアバターURL(同じ指示の再ロードを避ける) */
let syncedAvatarUrl: string | null = null;
/** ロード中に届いた切り替え指示(完了後に処理する) */
let pendingAvatarUrl: string | null = null;

function applyRemoteAvatar(url: string, name?: string): void {
  if (url === syncedAvatarUrl) return;
  syncedAvatarUrl = url;
  urlInput.value = url;
  const label = `アバターを切り替えています${name ? `: ${name}` : ''}`;
  setStatus(label);
  arController.showHint(label); // AR中はDOMのステータスが見えないため
  if (loading) {
    pendingAvatarUrl = url; // 今のロードが終わってから読み直す
    return;
  }
  void loadVRM(url);
}

/**
 * 配信者の音声パブリッシャー。presenceから届く最新値を保持する。
 * トランスポートより先に届くことも、張り直しでトランスポートが差し替わることも
 * あるため、状態はここに持ってトランスポート生成時に流し込む
 */
let remoteAudio: { sessionId: string; trackName: string } | null = null;

function applyRemoteAudio(audio: { sessionId: string; trackName: string } | null): void {
  remoteAudio = audio;
  if (liveTransport instanceof SfuTransport) liveTransport.setAudioPublisher(audio);
}

// 同接・コメント用WebSocket。切断時は少し間を置いて張り直す
function connectPresence(): void {
  setChatEnabled(false);
  // WebSocketはヘッダを付けられないので資格情報はクエリで運ぶ。
  // 配信者キーを持って開いた場合は配信者として接続する(気配を受け取れる)
  const path = withAuth('/api/presence', config.room, auth);
  const ws = new WebSocket(sameOriginWebSocketUrl(path));
  let pingTimer: number | null = null;
  ws.onopen = () => {
    presenceWs = ws;
    setChatEnabled(true);
    pingTimer = window.setInterval(() => ws.send('ping'), 30000);
  };
  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(String(event.data)) as PresenceMessage;
      if (data.type === 'count' && typeof data.count === 'number') {
        presenceCount = data.count;
      } else if (data.type === 'chat' && typeof data.text === 'string') {
        appendChat(data.text);
        spatialChat.push(data.text); // AR空間のフィードにも積む
      } else if (data.type === 'history' && Array.isArray(data.items)) {
        chatLog.replaceChildren();
        for (const item of data.items.slice(-CHAT_VISIBLE_MAX)) appendChat(item.text);
        spatialChat.setHistory(data.items.map((it) => it.text));
      } else if (data.type === 'avatar' && typeof data.url === 'string') {
        applyRemoteAvatar(data.url, data.name);
      } else if (data.type === 'audio') {
        // 配信者のマイクの開始/停止。以前は視聴側が30秒ごとに問い合わせていたが、
        // サーバーからの押し出しに変えた(視聴者×1日2,880回のリクエストが消える)
        applyRemoteAudio(data.audio ?? null);
      } else if (data.type === 'peer' && typeof data.id === 'string') {
        peers.apply(data.id, data);
      } else if (data.type === 'peerLeft' && typeof data.id === 'string') {
        peers.remove(data.id);
      } else if (data.type === 'peerMode') {
        peerMode = data.mode === 'broadcaster' || data.mode === 'off' ? data.mode : 'all';
        if (peerMode !== 'all') peers.clear(); // 配信者のみ/無効なら他人は見えない
      }
    } catch {
      // pong等は無視
    }
  };
  ws.onclose = () => {
    if (pingTimer !== null) window.clearInterval(pingTimer);
    presenceWs = null;
    presenceCount = null;
    setChatEnabled(false);
    window.setTimeout(connectPresence, 5000 + Math.random() * 3000);
  };
}

function stopDemo(): void {
  if (!demo.active) return;
  demo.stop();
  avatar?.resetPose();
  demoButton.textContent = 'デモ再生';
  demoButton.classList.remove('active');
}

function disconnectTransport(): void {
  if (!liveTransport) return;
  liveTransport.onStatus = null; // close()後の状態通知でUIを上書きさせない
  liveTransport.close();
  liveTransport = null;
  livePlayer = null;
  avatar?.resetPose();
  wsButton.textContent = '接続';
  transportSelect.disabled = false;
}

function connectTransport(kind: string, url: string): void {
  stopDemo();
  disconnectTransport();
  livePlayer = new PoseStreamPlayer();
  liveTransport =
    kind === 'sfu' ? new SfuTransport(url, config.room, auth) : new WebSocketTransport(url);
  if (liveTransport instanceof SfuTransport) {
    liveTransport.onAudioTrack = handleAudioTrack;
    // presenceで既に音声の開始を受け取っていれば、その状態から始める
    liveTransport.setAudioPublisher(remoteAudio);
  }
  liveTransport.onStatus = (text, isError) => setStatus(text, isError);
  liveTransport.onPacket = (bytes) => {
    netStats.bytes += bytes.byteLength;
    netStats.totalBytes += bytes.byteLength;
    netStats.packets += 1;
    lastLivePacketAt = performance.now();
    try {
      livePlayer?.push(decodePacket(bytes), performance.now());
    } catch (error) {
      console.warn('パケットのデコードに失敗:', error);
    }
  };
  liveTransport.connect();
  wsButton.textContent = '切断';
  transportSelect.disabled = true;
}

function describeError(error: unknown): string {
  // fetch失敗(ネットワーク断・CORS拒否)はProgressEventとして届き詳細を持たない
  if (error instanceof ProgressEvent) {
    return 'ネットワークエラーまたはCORSエラー(DevToolsのNetworkタブを確認してください)';
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function formatProgress(loaded: number, total: number): string {
  const loadedMb = (loaded / 1024 / 1024).toFixed(1);
  if (total > 0) {
    return `${loadedMb} / ${(total / 1024 / 1024).toFixed(1)} MB`;
  }
  return `${loadedMb} MB`;
}

// 将来の署名付きURL+暗号化配信(復号済みバッファの直接ロード)を見据えて
// URL / ArrayBuffer の両方を受け付ける
async function loadVRM(source: string | ArrayBuffer): Promise<void> {
  if (loading) return;
  loading = true;
  loadButton.disabled = true;
  setStatus('VRM 読み込み中...');
  // 表示できるアバターがまだ無いときだけ仮アバターを立てる。
  // 差し替え中は旧アバターをそのまま見せ続ける(視聴者ごとにDL完了時点で入れ替わる)
  placeholder.setVisible(avatar === null);

  try {
    const next = await Avatar.load(source, avatarRoot, {
      onProgress: (progress) => {
        setStatus(`VRM 読み込み中... ${formatProgress(progress.loaded, progress.total)}`);
      },
      // 表示に入れる前にシェーダとテクスチャをGPUへ載せておく
      precompile: { renderer, camera, scene },
    });

    // 新モデルのロードに成功してから旧モデルを外す(失敗時は表示を維持)。
    // GPUリソースの解放は重いので、見た目を切り替えたあと次のフレームで行う
    const previous = avatar;
    previous?.detach();
    avatar = next;
    if (previous) requestAnimationFrame(() => previous.dispose());
    avatar.applyScale(avatarRoot.scale.x); // AR中の差し替えでもスケールに追従
    arController.setAvatarBounds(avatar.bounds);
    placeholder.setVisible(false);

    // モーフ削減が走ったかは端末依存なので、コンソールを見なくても分かるよう表示する
    const morphNote =
      avatar.morphNotes.length > 0 ? `(モーフ整理: ${avatar.morphNotes.join(' / ')})` : '';
    setStatus(`VRM ${avatar.versionLabel} を表示中 ${morphNote}`);
    arController.showHint(`アバターを切り替えました ${morphNote}`);
    console.log('VRM loaded:', avatar.vrm);
  } catch (error) {
    console.error('VRM load error:', error);
    setStatus(`VRMの読み込みに失敗しました: ${describeError(error)}`, true);
    placeholder.setVisible(avatar === null);
  } finally {
    loading = false;
    loadButton.disabled = false;
    // ロード中に届いた切り替え指示を処理する
    const next = pendingAvatarUrl;
    pendingAvatarUrl = null;
    if (next && next !== source) void loadVRM(next);
  }
}

loadButton.addEventListener('click', () => {
  const url = urlInput.value.trim();
  if (url) void loadVRM(url);
});

urlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') loadButton.click();
});

demoButton.addEventListener('click', () => {
  if (demo.active) {
    stopDemo();
    setStatus('デモ停止');
  } else {
    disconnectTransport();
    demo.start();
    demoButton.textContent = 'デモ停止';
    demoButton.classList.add('active');
    setStatus('デモ再生中(ダミーモーション)');
  }
});

dropCheckbox.addEventListener('change', () => {
  demo.dropRate = dropCheckbox.checked ? 0.1 : 0;
});

wsButton.addEventListener('click', () => {
  if (liveTransport) {
    disconnectTransport();
    setStatus('切断しました');
  } else {
    const url = wsUrlInput.value.trim();
    if (url) connectTransport(transportSelect.value, url);
  }
});

// トランスポート切り替え時、URLが既定値のままなら新しい既定値に差し替える
transportSelect.addEventListener('change', () => {
  const defaults = Object.values(TRANSPORT_DEFAULT_URLS);
  if (defaults.includes(wsUrlInput.value.trim()) || wsUrlInput.value.trim() === '') {
    wsUrlInput.value = TRANSPORT_DEFAULT_URLS[transportSelect.value as TransportKind] ?? '';
  }
});

wsUrlInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !liveTransport) wsButton.click();
});

// ステージ(開発モード=全画面、視聴モード=16:9ボックス)のサイズに追従する
function resizeToStage(): void {
  const width = stage.clientWidth;
  const height = stage.clientHeight;
  if (width === 0 || height === 0) return;
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height);
}
new ResizeObserver(resizeToStage).observe(stage);

const clock = new THREE.Clock();

renderer.setAnimationLoop((_time: number, frame?: XRFrame) => {
  netStats.frames += 1;
  const delta = clock.getDelta();
  scenery.update(clock.elapsedTime);
  placeholder.update(clock.elapsedTime);
  contactShadow.update();
  arController.onFrame(frame);
  peers.update();

  // 自分の位置を一定間隔で送る(XR中はwindowのタイマーが止まるので描画ループから)
  if (clock.elapsedTime * 1000 - lastPeerSentAt > PEER_SEND_INTERVAL_MS) {
    lastPeerSentAt = clock.elapsedTime * 1000;
    sendPeerState();
  }

  if (avatar) {
    const now = performance.now();
    const player = livePlayer ?? (demo.active ? demo.player : null);
    const liveFrame = player?.sample(now);
    // デモ再生は常に配信側扱い。実配信はパケットが途切れたら待機モーションへ戻す
    const liveReady = Boolean(liveFrame?.pose) && (demo.active || now - lastLivePacketAt < IDLE_AFTER_MS);

    const step = delta * (1000 / IDLE_BLEND_MS);
    liveBlend = THREE.MathUtils.clamp(liveBlend + (liveReady ? step : -step), 0, 1);

    // 音声の音源をアバターの頭へ追従させる
    spatialAudio.setSourcePosition(avatar.getHeadWorldPosition(_headWorld));

    if (liveBlend >= 1 && liveFrame) {
      if (!liveOnly) {
        // 待機中のまばたきが「目を閉じたまま」で残らないよう、移行時に戻す
        avatar.vrm.expressionManager?.setValue('blink', 0);
        liveOnly = true;
      }
      avatar.applyPose(liveFrame);
    } else {
      liveOnly = false;
      const idleFrame = idleMotion.sample(now, avatar.restPose);
      avatar.applyPose(
        liveBlend > 0 && liveFrame ? blendPose(idleFrame, liveFrame, liveBlend) : idleFrame,
      );
    }
  }
  avatar?.update(delta);
  controls.update();
  renderer.render(scene, camera);
});

// 受け入れ確認(メモリリーク・デモ再生の滑らかさ検証)用に公開
Object.assign(window, {
  __viewerDebug: {
    renderer,
    loadVRM,
    demo,
    getVrm: () => avatar?.vrm ?? null,
    getAvatar: () => avatar,
    /** メッシュごとの表示状態・モーフ数・マテリアル設定を一覧する(実機での切り分け用) */
    inspectMeshes: () => {
      const rows: Record<string, unknown>[] = [];
      avatar?.vrm.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
          | (THREE.Material & { transparent?: boolean; side?: number })
          | undefined;
        const vertices = mesh.geometry?.getAttribute('position')?.count ?? 0;
        const morphs = mesh.geometry?.morphAttributes?.position?.length ?? 0;
        rows.push({
          name: mesh.name,
          visible: mesh.visible,
          frustumCulled: mesh.frustumCulled,
          vertices,
          morphs,
          // モーフはテクスチャに展開されるため、頂点数×成分×モーフ数のVRAMを食う
          morphMB: Number(((vertices * 4 * 4 * morphs) / 1024 / 1024).toFixed(1)),
          transparent: material?.transparent,
          side: material?.side,
          renderOrder: mesh.renderOrder,
        });
      });
      console.table(rows);
      return rows;
    },
    /**
     * 指定メッシュ(省略時は全部)のモーフターゲットを外す。
     * これで表示されるならモーフのVRAM圧迫が原因と確定できる(表情は動かなくなる)
     */
    disableMorphs: (meshName?: string) => {
      let hit = 0;
      avatar?.vrm.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        if (meshName && mesh.name !== meshName) return;
        if (!mesh.geometry?.morphAttributes?.position) return;
        mesh.geometry.morphAttributes = {};
        mesh.morphTargetInfluences = [];
        mesh.morphTargetDictionary = {};
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const m of materials) m.needsUpdate = true;
        hit += 1;
      });
      console.log(`[debug] ${hit}メッシュのモーフを外しました`);
      return hit;
    },
    placeholder,
    spatialAudio,
    avatarRoot,
    scene,
    scenery,
    THREE,
    setAvatarScale: (scale: number) => {
      avatarRoot.scale.setScalar(scale);
      avatar?.applyScale(scale);
      spatialAudio.setAvatarScale(scale);
    },
    setContactShadow: (on: boolean) => contactShadow.setARActive(on),
    setShadowMode,
    setAvatarSizeMode,
    setSpatialAudio,
    settingsPanel,
    spatialChat,
    arController,
  },
});

transportSelect.value = config.transport;
wsUrlInput.value = config.serverUrl;

urlInput.value = config.vrmUrl;
// 初期表示と同じアバターが同期で流れてきても読み直さないようにする
syncedAvatarUrl = config.vrmUrl;
void loadVRM(config.vrmUrl).then(() => {
  // デプロイ環境には既定VRMを置かないため、初回ロード失敗時は使い方を案内する
  if (!avatar && config.vrmUrl === DEFAULT_VRM_PATH) {
    setStatus(
      '既定のVRMがありません。上のURL欄にVRMのURL(CORS許可済み)を入れてロードするか、?vrm= で指定してください',
      true,
    );
  }
});

// ?transport=ws|sfu(+任意で ?server=)が付いていたら自動接続する。
// Worker配信ページなら「?vrm=...&transport=sfu」だけで視聴を開始できる
// (SFUプロキシが同一オリジンにあるため server の指定は不要)
if (config.autoConnect && config.serverUrl) {
  connectTransport(config.transport, config.serverUrl);
}
