import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { decodePacket } from '@xroomcast/protocol';
import { ArController } from './ar';
import { AvatarUnit, type AvatarUnitHooks } from './avatarUnit';
import { withAuth } from '@xroomcast/sync';
import { createAuth } from './auth';
import {
  DEFAULT_VRM_PATH,
  defaultServerUrls,
  readConfig,
  sameOriginWebSocketUrl,
  type RoomSettings,
  type StageState,
  type TransportKind,
} from './config';
import type { ShadowMode } from '@xroomcast/viewer-core';
import { DemoController } from './demo';
import { PeerPresence, type PeerDevice, type PeerState } from '@xroomcast/viewer-core';
import { SpatialAudio, isSpatialAudioSupported } from '@xroomcast/viewer-core';
import { SpatialChat } from './spatialChat';
import { SpatialPanel } from './spatialUI';
import { createStage, setupScenery } from '@xroomcast/viewer-core';
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
  /**
   * フォービエーションを切る。
   *
   * **three の既定は 1.0(最大)** で、視野の中心から離れるほど解像度を落とす。
   * HMDでは視線が中心にあるので効果的だが、**スマホARでは画面全体を見るので
   * ただのボケになる**(端末や描画負荷によって効き方が変わるため、
   * 「きれいなときと落ちるときがある」という見え方になる)。
   *
   * 0 = フォービエーションなし(全面フル解像度)
   */
  renderer.xr.setFoveation(0);
  stage.appendChild(renderer.domElement);
  return renderer;
}

const renderer = createRenderer();

const scene = new THREE.Scene();

/**
 * ニアクリップは短いほど、アバターに顔を近づけても中が透けない。
 * 既定の0.1(10cm)はARでは長く、**そこまで寄っていないつもりでも
 * 顔や体の内側が見えてしまう**(WebXRのdepthNearにもこの値が渡る)。
 *
 * 代わりにファーを詰めて深度バッファの精度を確保する。ARで50mも要らないうえ、
 * near/farの比が広いほど接地影などでZファイティングが出やすい
 */
const CAMERA_NEAR = 0.02;
const CAMERA_FAR = 30;

const camera = new THREE.PerspectiveCamera(
  30,
  stage.clientWidth / Math.max(1, stage.clientHeight),
  CAMERA_NEAR,
  CAMERA_FAR,
);
camera.position.set(0, 1.3, 2.5);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.0, 0);
controls.enableDamping = true;
controls.update();

// パステル背景・ライティング・浮遊プリミティブ
const scenery = setupScenery(scene);

// 部屋の配置フレーム。AR設置・つかみ移動・卓上スケールはこのグループの
// 変換として行い、視聴者(peer)座標の基準もここに置く。
// 「視聴者が置いた場所」を表すアンカーなので、設置以外では動かさない
const roomSpace = new THREE.Group();
scene.add(roomSpace);

// ---- 配信ストリームごとの表示ユニット ----
// slotフレーム+アバター+ジッタバッファ+接地影+待機モーションを AvatarUnit に
// 束ねる。slot 0 が主ユニット(現行の単一配信)。複数配信者ではここが増える。
// 将来のロコモーション(SECTION_ROOT)では、roomSpace は動かさず unit.root が
// roomSpace の中で動く
const units = new Map<number, AvatarUnit>();

/** 席数の上限(Worker側のMAX_PUBLISHERSと合わせる) */
const MAX_SLOTS = 8;
/** 席の間隔。slot 0 を中心に左右交互へ広げる */
const SLOT_SPACING = 0.9;

// AR中かどうか(あとから生えたユニットにも接地影のARモードを引き継ぐ)
let arModeActive = false;

function createUnit(slot: number, hooks?: AvatarUnitHooks): AvatarUnit {
  const unit = new AvatarUnit({
    parent: roomSpace,
    precompile: { renderer, camera, scene },
    hooks,
  });
  unit.applyScale(roomSpace.scale.x);
  unit.setShadowARActive(arModeActive);
  const first = units.get(0);
  if (first) unit.setShadowMode(first.getShadowMode());
  units.set(slot, unit);
  return unit;
}

function slotOffsetX(slot: number): number {
  if (slot === 0) return 0;
  const step = Math.ceil(slot / 2) * SLOT_SPACING;
  return slot % 2 === 1 ? step : -step;
}

/** 席のユニットを取得し、無ければ席の位置に作る */
function ensureUnit(slot: number): AvatarUnit {
  let unit = units.get(slot);
  if (!unit) {
    unit = createUnit(slot);
    unit.root.position.x = slotOffsetX(slot);
  }
  return unit;
}

// 主ユニット。ステータス表示などのUI通知はこのユニットだけに付ける
const primaryUnit = createUnit(0, {
  onLoadingChanged: (loading) => {
    loadButton.disabled = loading;
    if (loading) setStatus('VRM 読み込み中...');
  },
  onProgress: (loaded, total) => {
    setStatus(`VRM 読み込み中... ${formatProgress(loaded, total)}`);
  },
  onLoaded: (avatar) => {
    arController.setAvatarBounds(avatar.bounds);
    // モーフ削減が走ったかは端末依存なので、コンソールを見なくても分かるよう表示する
    const morphNote =
      avatar.morphNotes.length > 0 ? `(モーフ整理: ${avatar.morphNotes.join(' / ')})` : '';
    setStatus(`VRM ${avatar.versionLabel} を表示中 ${morphNote}`);
    arController.showHint(`アバターを切り替えました ${morphNote}`);
    console.log('VRM loaded:', avatar.vrm);
  },
  onError: (error) => {
    console.error('VRM load error:', error);
    setStatus(`VRMの読み込みに失敗しました: ${describeError(error)}`, true);
  },
});

/**
 * AR中のステージ(足元の台と浮遊装飾)。
 * **roomSpace にぶら下げる**ので、設置した場所へステージごと乗り、
 * ミニ 1/10 にすれば卓上サイズのジオラマになる(ステージは部屋の持ち物で、
 * アバターがロコモーションで動いてもついて行かない)
 */
const arStage = createStage();
roomSpace.add(arStage.object);
/** ステージを出すか(AR中のみ意味を持つ。ARを抜けたら常に隠す) */
let stageEnabled = true;

/** 配信者が決めたステージ(未受信のうちは組み込みの装飾) */
let stageState: StageState = { source: 'builtin' };

function refreshStage(): void {
  // 「なし」なら視聴者側の切り替えに関わらず出さない
  const wanted = stageEnabled && stageState.source !== 'none';
  arStage.setVisible(wanted);
  // ステージを出している間はPC表示の装飾を引っ込める(二重に飾らない)
  scenery.setDecorationsVisible(!wanted);
}

function setStageEnabled(on: boolean): void {
  stageEnabled = on;
  refreshStage();
  settingsPanel.setActive(on ? 'stage-on' : 'stage-off');
  for (const button of stageButtons) {
    button.classList.toggle('active', (button.dataset.stage === 'on') === on);
  }
}

/** 配信者からのステージ設定を反映する */
function applyStageState(next: StageState): void {
  stageState = next;
  arStage.setSource(next.source);
  scenery.setTheme({ sky: next.sky ?? null, ground: next.ground ?? null });
  if (next.source === 'model') {
    void arStage.loadModel(next.url ?? null).catch((error) => {
      console.warn('[stage] モデルの読み込みに失敗:', error);
    });
  } else {
    void arStage.loadModel(null);
  }
  refreshStage();
}

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
      initial: primaryUnit.getShadowMode(),
      onSelect: (value) => setShadowMode(value as ShadowMode),
    },
    {
      title: '音声',
      // 空間が使えない端末(iOS)では選択肢に出さない。選んでも無音になるだけ
      options: isSpatialAudioSupported()
        ? [
            { label: '空間(頭から鳴る)', value: 'spatial' },
            { label: '通常', value: 'flat' },
          ]
        : [{ label: '通常(この端末は空間非対応)', value: 'flat' }],
      initial: isSpatialAudioSupported() ? 'spatial' : 'flat',
      onSelect: (value) => setSpatialAudio(value === 'spatial'),
    },
    {
      title: 'ステージ',
      options: [
        { label: '出す', value: 'stage-on' },
        { label: '隠す', value: 'stage-off' },
      ],
      initial: 'stage-on',
      onSelect: (value) => setStageEnabled(value === 'stage-on'),
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
  roomSpace,
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
    arModeActive = arActive;
    for (const unit of units.values()) unit.setShadowARActive(arActive);
    // ステージはPC表示でも出す(配信の見た目そのものなので)
    refreshStage();
  },
);
arController.onDefaultLightScale = (scale) => scenery.setLightScale(scale);
// ピンチ/両手グリップで無段階に変えたときもUIの選択状態を追従させる
arController.onScaleChanged = (scale) => {
  for (const unit of units.values()) unit.applyScale(scale);
  spatialAudio.setAvatarScale(scale);
  syncSizeUi(scale);
};

// ---- AR中のUI(スマホ=画面固定のDOM / HMD=空間パネル) ----
const arControls = document.getElementById('ar-controls') as HTMLElement;
const sizeButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-size]')];
const shadowButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-shadow]')];
const audioButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-audio]')];
const peerButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-peers]')];
const stageButtons = [...arControls.querySelectorAll<HTMLButtonElement>('[data-stage]')];

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
  roomSpace.scale.setScalar(scale);
  for (const unit of units.values()) unit.applyScale(scale);
  spatialAudio.setAvatarScale(scale);
  syncSizeUi(scale);
}

function setShadowMode(mode: ShadowMode): void {
  for (const unit of units.values()) unit.setShadowMode(mode);
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

for (const button of stageButtons) {
  button.addEventListener('beforexrselect', (event) => event.preventDefault());
  button.addEventListener('click', () => setStageEnabled(button.dataset.stage === 'on'));
}
setStageEnabled(stageEnabled);

const replaceButton = document.getElementById('ar-replace') as HTMLButtonElement;
replaceButton.addEventListener('beforexrselect', (event) => event.preventDefault());
replaceButton.addEventListener('click', () => arController.requestPlacement());

/**
 * 解像度の診断。AR中はコンソールを見られないので、実測値をヒント欄へ出す。
 * ボケが「描画バッファが小さい」のか「アプリが画面ごと縮小している」のかで
 * 対処がまったく変わるため、まず測る
 */
const resolutionButton = document.getElementById('ar-resolution') as HTMLButtonElement;
resolutionButton.addEventListener('beforexrselect', (event) => event.preventDefault());
resolutionButton.addEventListener('click', () => arController.showHint(arController.resolutionReport));

// 設定パネルの開閉(項目が増えて視界を塞ぐため、既定は閉じておく)
const settingsToggle = document.getElementById('ar-settings-toggle') as HTMLButtonElement;
settingsToggle.addEventListener('beforexrselect', (event) => event.preventDefault());
settingsToggle.addEventListener('click', () => {
  const open = arControls.hidden;
  arControls.hidden = !open;
  settingsToggle.classList.toggle('active', open);
  settingsToggle.textContent = open ? '✕ 閉じる' : '⚙ 設定';
});

syncSizeUi(roomSpace.scale.x);
setShadowMode(primaryUnit.getShadowMode());

/** 音源位置の計算に使い回すベクトル */
const _headWorld = new THREE.Vector3();

// 他の視聴者の気配。位置は部屋(roomSpace)基準の相対座標でやり取りする
const peers = new PeerPresence(roomSpace);

const demo = new DemoController();
let liveTransport: Transport | null = null;


// 転送量・描画の統計(視聴モードでステージ下に表示)
const netStats = { bytes: 0, packets: 0, totalBytes: 0, frames: 0 };
let presenceCount: number | null = null;

// 配信停止中オーバーレイ: 最後のポーズパケットから5秒空いたら表示する
const offlineOverlay = document.getElementById('offline-overlay') as HTMLDivElement;
const offlineBadge = offlineOverlay.querySelector('.badge') as HTMLDivElement;
const offlineHint = offlineOverlay.querySelector('.hint') as HTMLDivElement;
const OFFLINE_AFTER_MS = 5000;

/**
 * 視聴できない理由。満員・停止中は「待てば戻る状態」なので、
 * 配信が来ていないだけの状態とは区別して案内する
 */
const UNAVAILABLE_TEXT: Record<string, { badge: string; hint: string }> = {
  full: {
    badge: '🈵 満員です',
    hint: '同時に見られる人数の上限に達しています。空きが出ると自動でつながります',
  },
  stopped: {
    badge: '⏸ 配信は一時停止中です',
    hint: '配信者が再開すると自動で動き出します',
  },
};
let unavailableReason: string | null = null;

function refreshOfflineOverlay(): void {
  if (unavailableReason) {
    const text = UNAVAILABLE_TEXT[unavailableReason];
    offlineBadge.textContent = text?.badge ?? '視聴できません';
    offlineHint.textContent = text?.hint ?? '';
    offlineOverlay.hidden = false;
    return;
  }
  offlineBadge.textContent = '⏸ 配信は停止中です';
  offlineHint.textContent = '配信が始まると自動で動き出します';
  offlineOverlay.hidden = performance.now() - primaryUnit.lastPacketAt < OFFLINE_AFTER_MS;
}

/** 満員・停止中は視聴モードでなくても知らせる(理由が分からないと待てない) */
function setUnavailable(reason: string | null): void {
  unavailableReason = reason;
  if (reason) setStatus(UNAVAILABLE_TEXT[reason]?.badge ?? '視聴できません', true);
  refreshOfflineOverlay();
}

if (watchMode) window.setInterval(refreshOfflineOverlay, 1000);

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
/** 席ごとの最新トラックと、いま鳴っている席(音声ボタンの表示判定に使う) */
const audioTracks = new Map<number, MediaStreamTrack>();
const audibleSlots = new Set<number>();

function refreshAudioButton(): void {
  // ボタンの表示を先に決める。再生側で例外が出ても操作手段だけは残す
  audioButton.hidden = audibleSlots.size === 0;
}

function handleAudioTrack(slot: number, track: MediaStreamTrack | null): void {
  // ボタンの表示を**先に**決める。再生側(WebAudioの接続)で例外が出ても
  // 操作手段だけは残す(setTrackを先にすると、失敗時にボタンが出なくなる)
  if (!track) {
    audioTracks.delete(slot);
    audibleSlots.delete(slot);
    refreshAudioButton();
  } else {
    audioTracks.set(slot, track);
    audibleSlots.add(slot);
    refreshAudioButton();
    // 配信者側が停止するとリモートトラックはmuteになる(endedは飛んでこない)
    const dropIfCurrent = (): void => {
      if (audioTracks.get(slot) === track) {
        audibleSlots.delete(slot);
        refreshAudioButton();
      }
    };
    track.onmute = dropIfCurrent;
    track.onended = dropIfCurrent;
    track.onunmute = () => {
      if (audioTracks.get(slot) === track) {
        audibleSlots.add(slot);
        refreshAudioButton();
      }
    };
  }
  try {
    spatialAudio.setTrack(track, slot);
  } catch (error) {
    console.warn('[audio] 再生ノードの接続に失敗:', error);
  }
}

audioButton.addEventListener('click', () => {
  audioMuted = !audioMuted;
  if (!audioMuted) void spatialAudio.resume();
  spatialAudio.setMuted(audioMuted);
  audioButton.textContent = audioMuted ? '🔇 タップで音声ON' : '🔊 音声ON';
  audioButton.classList.toggle('on', !audioMuted);
});

function setSpatialAudio(on: boolean): void {
  // 使えない端末では選ばせない(選べても無音になるだけなので)
  const effective = on && spatialAudio.spatialSupported;
  spatialAudio.setSpatial(effective);
  const value = effective ? 'spatial' : 'flat';
  settingsPanel.setActive(value);
  for (const button of audioButtons) {
    button.classList.toggle('active', button.dataset.audio === value);
  }
}

/**
 * iOS は WebRTC のリモート音声を Web Audio へ流せないため、空間オーディオが
 * 無音になる。既定を通常再生にしたうえで、選択肢そのものを無効化して
 * 「選んだのに聞こえない」を防ぐ
 */
if (!spatialAudio.spatialSupported) {
  for (const button of audioButtons) {
    if (button.dataset.audio !== 'spatial') continue;
    button.disabled = true;
    button.title = 'この端末では空間オーディオを利用できません';
    button.textContent = '空間(非対応)';
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
  // 接続していても、ルーム設定でコメントを止めていれば使えない
  const usable = enabled && chatAllowed;
  chatInput.disabled = !usable;
  chatSendButton.disabled = !usable;
  chatInput.placeholder = chatAllowed ? 'コメントを入力' : 'コメントは停止中です';
}

interface PresenceMessage extends PeerState {
  type?: string;
  count?: number;
  text?: string;
  items?: { text: string }[];
  /** type==='avatar': 配信者が選んだVRMの配信URL */
  url?: string;
  name?: string;
  /** type==='avatar': 席番号(複数配信者)。無ければ slot 0 */
  slot?: number;
  /** type==='publishers': 配信者の席割り当て一覧 */
  publishers?: { slot: number; sessionId: string }[];
  /** type==='peer' / 'peerLeft': 送信元の接続ID */
  id?: string;
  /** type==='peerMode': 気配の公開範囲 */
  mode?: string;
  /** type==='audio': 配信者の音声パブリッシャー(停止時はnull) */
  audio?: { sessionId: string; trackName: string } | null;
  /** type==='settings': ルーム設定 */
  settings?: RoomSettings;
  /** type==='admission': 入室証 */
  token?: string;
  /** type==='stage': 配信者が決めたステージ */
  stage?: StageState;
}

/** 入室証。presence接続後に届く。トランスポートを作り直しても持ち回る */
let admissionToken = '';

/** 気配の公開範囲(サーバーが決める。配信者コンソールから変更できる) */
let peerMode: 'all' | 'broadcaster' | 'off' = 'all';
/** コメントを受け付けるか(ルーム設定。既定は許可) */
let chatAllowed = true;

function applyPeerMode(mode: string | undefined): void {
  peerMode = mode === 'broadcaster' || mode === 'off' ? mode : 'all';
  if (peerMode !== 'all') peers.clear(); // 配信者のみ/無効なら他人は見えない
}

/**
 * ルーム設定の反映。サーバーが接続時と変更時に押し出してくる。
 * 公開配信・非公開配信・イベント会場の違いはここの値だけで表現する
 */
function applyRoomSettings(settings: RoomSettings): void {
  applyPeerMode(settings.peerMode);
  chatAllowed = settings.chat;
  // 接続中でもコメントだけ止められる。入力欄の状態は接続状態と両方を見る
  setChatEnabled(presenceWs !== null);
}

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

/**
 * ワールド姿勢を部屋(roomSpace)基準のローカル姿勢に直して [x,y,z,qx,qy,qz,qw] にする。
 * 基準を設置アンカーに置くことで、アバターがロコモーションで動いても
 * 静止している視聴者の気配が引きずられない
 */
function toPeerNode(matrixWorld: THREE.Matrix4): number[] {
  _frameInverse.copy(roomSpace.matrixWorld).invert().multiply(matrixWorld);
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
  roomSpace.updateWorldMatrix(true, false);

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

/** 配信者から指示された最後のアバターURL(席ごと。同じ指示の再ロードを避ける) */
const syncedAvatarUrls = new Map<number, string>();

function applyRemoteAvatar(slot: number, url: string, name?: string): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  if (syncedAvatarUrls.get(slot) === url) return;
  syncedAvatarUrls.set(slot, url);
  if (slot === 0) urlInput.value = url;
  const label = `アバターを切り替えています${name ? `: ${name}` : ''}`;
  setStatus(label);
  arController.showHint(label); // AR中はDOMのステータスが見えないため
  // ロード中でもユニット側が覚えていて、完了後に読み直す
  void ensureUnit(slot).load(url);
}

/** いまポーズ配信元が居る席(退席の片付けの判断に使う) */
let livePublisherSlots = new Set<number>();

/** 席のユニットと付随する状態(音源・トラック記録)をまとめて畳む */
function disposeUnit(slot: number): void {
  const unit = units.get(slot);
  if (!unit) return;
  unit.dispose();
  units.delete(slot);
  syncedAvatarUrls.delete(slot);
  remoteAudios.delete(slot);
  spatialAudio.removeSource(slot);
  audioTracks.delete(slot);
  audibleSlots.delete(slot);
  refreshAudioButton();
}

/**
 * 配信者の席割り当て。席ぶんのユニットを用意し、消えた席は片付ける。
 * ポーズの購読の張り直しはトランスポート側が指紋比較で判断する
 */
function applyPublishers(list: { slot: number; sessionId: string }[]): void {
  const active = new Set<number>([0]); // 主ユニットは常に残す
  /**
   * アバターが割り当てられている席は、配信元が居なくても表示を残す。
   * 入室直後は「席のアバター」→「配信者の顔ぶれ」の順で届くため、ここで
   * 配信元だけを見ると、アバターを設定しただけの席(待機表示)を
   * 作った直後に片付けてしまう。
   * 退席時のアバター削除はサーバーが avatarCleared で明示的に指示する
   */
  for (const slot of syncedAvatarUrls.keys()) active.add(slot);
  livePublisherSlots = new Set<number>();
  for (const p of list) {
    if (typeof p.slot !== 'number' || p.slot < 0 || p.slot >= MAX_SLOTS) continue;
    active.add(p.slot);
    livePublisherSlots.add(p.slot);
    ensureUnit(p.slot);
  }
  for (const slot of [...units.keys()]) {
    if (!active.has(slot)) disposeUnit(slot);
  }
  if (liveTransport instanceof SfuTransport) liveTransport.notifyPublishers(list);
}

/**
 * 席のアバター解除(退席の片付け)。配信元も居ない席はユニットごと畳む。
 * 席0は主ユニットなので畳まない(1人配信の待機表示を保つ)
 */
function applyAvatarCleared(slot: number): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  syncedAvatarUrls.delete(slot);
  if (slot === 0 || livePublisherSlots.has(slot)) return;
  disposeUnit(slot);
}

/**
 * 配信者の音声パブリッシャー(席ごと)。presenceから届く最新値を保持する。
 * トランスポートより先に届くことも、張り直しでトランスポートが差し替わることも
 * あるため、状態はここに持ってトランスポート生成時に流し込む
 */
const remoteAudios = new Map<number, { sessionId: string; trackName: string } | null>();

function applyRemoteAudio(
  slot: number,
  audio: { sessionId: string; trackName: string } | null,
): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  remoteAudios.set(slot, audio);
  if (liveTransport instanceof SfuTransport) liveTransport.setAudioPublisher(audio, slot);
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
        applyRemoteAvatar(typeof data.slot === 'number' ? data.slot : 0, data.url, data.name);
      } else if (data.type === 'publishers' && Array.isArray(data.publishers)) {
        applyPublishers(data.publishers);
      } else if (data.type === 'avatarCleared' && typeof data.slot === 'number') {
        applyAvatarCleared(data.slot);
      } else if (data.type === 'audio') {
        // 配信者のマイクの開始/停止(席ごと)。以前は視聴側が30秒ごとに問い合わせていたが、
        // サーバーからの押し出しに変えた(視聴者×1日2,880回のリクエストが消える)
        applyRemoteAudio(typeof data.slot === 'number' ? data.slot : 0, data.audio ?? null);
      } else if (data.type === 'peer' && typeof data.id === 'string') {
        peers.apply(data.id, data);
      } else if (data.type === 'peerLeft' && typeof data.id === 'string') {
        peers.remove(data.id);
      } else if (data.type === 'admission' && typeof data.token === 'string') {
        // 入室が許された証明。満員のルームでもSFUを使えるようにする
        admissionToken = data.token;
        if (liveTransport instanceof SfuTransport) liveTransport.setAdmission(admissionToken);
      } else if (data.type === 'stage' && data.stage) {
        applyStageState(data.stage);
      } else if (data.type === 'settings' && data.settings) {
        applyRoomSettings(data.settings);
      } else if (data.type === 'peerMode') {
        // 旧サーバー互換。設定メッセージが来ていればそちらが優先される
        applyPeerMode(data.mode);
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
  for (const unit of units.values()) unit.resetPose();
  demoButton.textContent = 'デモ再生';
  demoButton.classList.remove('active');
}

function disconnectTransport(): void {
  if (!liveTransport) return;
  liveTransport.onStatus = null; // close()後の状態通知でUIを上書きさせない
  liveTransport.close();
  liveTransport = null;
  for (const unit of units.values()) unit.resetPose();
  wsButton.textContent = '接続';
  transportSelect.disabled = false;
}

/** 受信パケットを席のユニットへ届ける(デコード失敗は警告のみ) */
function routePacket(slot: number, bytes: Uint8Array): void {
  if (slot < 0 || slot >= MAX_SLOTS) return;
  try {
    ensureUnit(slot).pushPacket(decodePacket(bytes), performance.now());
  } catch (error) {
    console.warn('パケットのデコードに失敗:', error);
  }
}

function connectTransport(kind: string, url: string): void {
  stopDemo();
  disconnectTransport();
  const transport =
    kind === 'sfu' ? new SfuTransport(url, config.room, auth) : new WebSocketTransport(url);
  liveTransport = transport;
  if (transport instanceof SfuTransport) {
    transport.onAudioTrackFrom = handleAudioTrack;
    transport.onUnavailable = setUnavailable;
    if (admissionToken) transport.setAdmission(admissionToken);
    // presenceで既に音声の開始を受け取っていれば、その状態から始める(席ごと)
    for (const [slot, audio] of remoteAudios) transport.setAudioPublisher(audio, slot);
    // SFUは配信者ごとにDataChannelが分かれており、席番号つきで届く
    transport.onPacketFrom = routePacket;
  }
  transport.onStatus = (text, isError) => setStatus(text, isError);
  transport.onPacket = (bytes) => {
    netStats.bytes += bytes.byteLength;
    netStats.totalBytes += bytes.byteLength;
    netStats.packets += 1;
    // WS直結はブリッジ1本のストリームなので主ユニット(slot 0)へ。
    // SFUの振り分けは onPacketFrom が行う(こちらは統計のみ)
    if (!(transport instanceof SfuTransport)) routePacket(0, bytes);
  };
  transport.connect();
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
// URL / ArrayBuffer の両方を受け付ける。ロードの実体と進捗・完了の通知は
// AvatarUnit(のフック)に移っている
async function loadVRM(source: string | ArrayBuffer): Promise<void> {
  await primaryUnit.load(source);
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
  arStage.update(clock.elapsedTime);
  arController.onFrame(frame);
  peers.update();

  // 自分の位置を一定間隔で送る(XR中はwindowのタイマーが止まるので描画ループから)
  if (clock.elapsedTime * 1000 - lastPeerSentAt > PEER_SEND_INTERVAL_MS) {
    lastPeerSentAt = clock.elapsedTime * 1000;
    sendPeerState();
  }

  // ポーズ適用。未接続でデモ中はデモのバッファを全ユニットへ流す(2体表示の検証にも使う)
  const now = performance.now();
  const demoPlayer = !liveTransport && demo.active ? demo.player : null;
  for (const [slot, unit] of units) {
    unit.update({
      now,
      delta,
      elapsed: clock.elapsedTime,
      player: liveTransport ? unit.player : demoPlayer,
      alwaysLive: demoPlayer !== null,
      // 席の音声から口パクを駆動する(音が無い席では null)
      lipSync: spatialAudio.sampleLipSync(slot, delta),
    });
  }

  // 音声の音源を各席のアバターの頭へ追従させる
  for (const [slot, unit] of units) {
    const head = unit.getHeadWorldPosition(_headWorld);
    if (head) spatialAudio.setSourcePosition(head, slot);
  }

  controls.update();
  renderer.render(scene, camera);
});

// 受け入れ確認(メモリリーク・デモ再生の滑らかさ検証)用に公開
Object.assign(window, {
  __viewerDebug: {
    renderer,
    loadVRM,
    demo,
    getVrm: () => primaryUnit.avatar?.vrm ?? null,
    getAvatar: () => primaryUnit.avatar,
    /** メッシュごとの表示状態・モーフ数・マテリアル設定を一覧する(実機での切り分け用) */
    inspectMeshes: () => {
      const rows: Record<string, unknown>[] = [];
      primaryUnit.avatar?.vrm.scene.traverse((object) => {
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
      primaryUnit.avatar?.vrm.scene.traverse((object) => {
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
    spatialAudio,
    roomSpace,
    units,
    primaryUnit,
    /** 複数配信者の描画検証用: 同じストリームで動く2体目を隣に生やす */
    spawnTestUnit: (offsetX = 0.9, url?: string) => {
      const slot = Math.max(...units.keys()) + 1;
      const unit = createUnit(slot);
      unit.root.position.x = offsetX;
      const source = url ?? urlInput.value.trim();
      if (source) void unit.load(source);
      return unit;
    },
    removeTestUnit: (slot: number) => {
      if (slot === 0) return false;
      const unit = units.get(slot);
      unit?.dispose();
      units.delete(slot);
      return unit !== undefined;
    },
    scene,
    scenery,
    THREE,
    setAvatarScale: (scale: number) => {
      roomSpace.scale.setScalar(scale);
      for (const unit of units.values()) unit.applyScale(scale);
      spatialAudio.setAvatarScale(scale);
    },
    setContactShadow: (on: boolean) => {
      for (const unit of units.values()) unit.setShadowARActive(on);
    },
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
syncedAvatarUrls.set(0, config.vrmUrl);
void loadVRM(config.vrmUrl).then(() => {
  // デプロイ環境には既定VRMを置かないため、初回ロード失敗時は使い方を案内する
  if (!primaryUnit.avatar && config.vrmUrl === DEFAULT_VRM_PATH) {
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
