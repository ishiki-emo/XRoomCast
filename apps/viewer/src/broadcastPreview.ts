/**
 * 配信者コンソールの3Dプレビュー。
 *
 * 視聴者に実際に届いている姿(SFU経由で受信したポーズを、視聴者と同じ
 * PoseApplierへ通したもの)と、視聴者がどこに居るかを同じ画面で見る。
 * VSeeFaceのプレビューは「送った姿」なので、届いた結果はここでしか分からない。
 *
 * 視聴ページ(main.ts)とはシーンを共有せず、必要なモジュールだけ組み立てている。
 * AR・空間UI・コメント表示は要らないぶん軽い。
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { VRMFirstPerson } from '@pixiv/three-vrm';
import { decodePacket } from '@xroomcast/protocol';
import { Avatar } from '@xroomcast/viewer-core';
import type { AuthProvider, SampledFrame } from '@xroomcast/sync';
import type { HmdBroadcast } from './hmdBroadcast';
import { IdleMotion, blendPose } from '@xroomcast/viewer-core';
import { PeerPresence, type PeerState } from '@xroomcast/viewer-core';
import { PoseStreamPlayer } from '@xroomcast/sync';
import { SfuTransport } from '@xroomcast/sync';
import { SpatialPanel, type PanelSection } from './spatialUI';
import { XrPanelController } from './xrPanelController';
import { HandMenu } from './handMenu';
import { MicLipSync } from './micLipSync';

const IDLE_AFTER_MS = 5000;
const IDLE_BLEND_MS = 700;

export interface PreviewHandle {
  /** 配信者コンソールが受け取ったアバター切り替えを反映する */
  setAvatarUrl(url: string): void;
  /** Presence WebSocket から届いた視聴者の位置 */
  applyPeer(id: string, state: PeerState): void;
  removePeer(id: string): void;
  clearPeers(): void;
  setStatus(text: string): void;
  /** HMDで入って自分の動きを配信する(対応端末でのみ解決する) */
  enterHmd(mode: XrMode): Promise<void>;
  exitHmd(): void;
  /** パススルー(ar) / 没入(vr) それぞれの対応状況 */
  readonly hmdSupported: Promise<{ ar: boolean; vr: boolean }>;
  /** 鏡(自分の姿)の表示切り替え */
  setMirrorVisible(on: boolean): void;
  /** 空間パネルからも操作できるよう、外側のUIと状態を合わせるためのフック */
  onMicToggle: (() => void) | null;
  /** HMD内のパネルで「配信を開始/停止」を押したとき(VRに入るのと配信は別にしてある) */
  onBroadcastStart: (() => void) | null;
  onBroadcastStop: (() => void) | null;
  /** パネルの配信の開始/停止の表示を、実際の状態に合わせる */
  setBroadcastLabel(on: boolean): void;
  onWristChange: ((axis: 'x' | 'y' | 'z', delta: number) => void) | null;
  /** 手首の向きを既定に戻す(HMD内パネルから) */
  onWristReset: (() => void) | null;
  setWristLabel(text: string): void;
  setMicLabel(on: boolean): void;
  /**
   * 手元の姿勢を直接映す(Webカメラ配信中)。null で、視聴者に届いた姿を映す元の動きに戻る。
   * 届いた姿は通信と再生の遅れで0.2秒以上遅れるので、自分の動きの確認にはもたついて見える
   */
  setLocalPose(source: (() => SampledFrame | null) | null): void;
  /** 鏡の口を動かすマイク音声。マイクの取得・解放に合わせて渡す(nullで口を閉じる) */
  setMicTrack(track: MediaStreamTrack | null): void;
}

export type XrMode = 'ar' | 'vr';

export function setupBroadcastPreview(options: {
  canvas: HTMLCanvasElement;
  statusEl: HTMLElement;
  room: string;
  /** 配信者の資格情報。プレビューは自分の配信を視聴している状態なので視聴にも使う */
  auth: AuthProvider;
  /** HMD配信。XRセッション中に頭・手の姿勢を送る */
  broadcast: HmdBroadcast;
  /**
   * アバターを読み込んだとき。頭の高さはWebカメラ配信の頭の位置の基準に、
   * 表情の名前はWebカメラ配信の表情の割り当て先の一覧に使う
   */
  onAvatarLoaded?: (info: { height: number; stature: number | null; expressions: string[] }) => void;
}): PreviewHandle {
  const { canvas, statusEl, room, auth, broadcast } = options;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.xr.enabled = true;
  // 視聴ページと揃える(threeの既定1.0だと周辺の解像度が落ちてボケる)
  renderer.xr.setFoveation(0);

  const scene = new THREE.Scene();
  const backgroundColor = new THREE.Color(0x1b1b22);
  scene.background = backgroundColor;

  // ニアクリップは視聴ページと揃える(HMD配信中はこのカメラがXRで使われる)
  const camera = new THREE.PerspectiveCamera(35, 1, 0.02, 30);
  camera.position.set(0, 1.35, 2.6);

  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1.0, 0);
  controls.enableDamping = true;

  scene.add(new THREE.HemisphereLight(0xffffff, 0x30303a, 1.4));
  const key = new THREE.DirectionalLight(0xffffff, 1.6);
  key.position.set(2, 4, 3);
  scene.add(key);

  // 足元のグリッド(向きと距離感の手がかり)
  const grid = new THREE.GridHelper(6, 12, 0x4a4a58, 0x2e2e38);
  scene.add(grid);

  /**
   * アバターの配置フレーム。視聴者の位置はこのローカル座標で届く。
   * HMDで入ったときは、自分の少し前に立たせて「視聴者から見た自分」を
   * 確認できるようにする(一人称にすると自分の姿が見えない)
   */
  const avatarRoot = new THREE.Group();
  scene.add(avatarRoot);

  /**
   * 視聴者を置く基準。
   * 画面で見ているときはアバターに合わせるが、HMDで配信している間は
   * 「配信者自身」に合わせる。配信者にとってアバターは自分自身なので、
   * こうすると視聴者が自分の周りに並び、手を伸ばせば届く位置関係になる
   */
  const peerRoot = new THREE.Group();
  scene.add(peerRoot);
  const peers = new PeerPresence(peerRoot);
  const idleMotion = new IdleMotion();

  let avatar: Avatar | null = null;
  let loading = false;
  let currentUrl: string | null = null;
  let liveBlend = 0;
  let lastPacketAt = 0;
  let localPose: (() => SampledFrame | null) | null = null;
  const micLipSync = new MicLipSync();
  /** リップシンクが口を駆動中か(マイクが止まった瞬間に口を閉じるために持つ) */
  let lipSyncActive = false;

  const player = new PoseStreamPlayer();
  const transport = new SfuTransport(location.origin, room, auth);
  transport.onPacket = (bytes) => {
    lastPacketAt = performance.now();
    try {
      player.push(decodePacket(bytes), performance.now());
    } catch {
      // 壊れたパケットは捨てる(視聴ページと同じ扱い)
    }
  };
  transport.onStatus = (text, isError) => {
    if (isError) setStatus(text);
  };
  transport.connect();

  /**
   * アバターの頭の骨から目までのずれ(配置のローカル座標・レスト姿勢)。VRM の視線の設定
   * (lookAt の offsetFromHeadBone)から求める。設定が無ければ null(ずれなしとして扱う)
   */
  function measureEyeOffset(target: Avatar): THREE.Vector3 | null {
    const head = target.vrm.humanoid.getNormalizedBoneNode('head');
    const lookAt = target.vrm.lookAt;
    if (!head || !lookAt) return null;
    avatarRoot.updateMatrixWorld(true);
    const eye = avatarRoot.worldToLocal(lookAt.getLookAtWorldPosition(new THREE.Vector3()));
    const headLocal = avatarRoot.worldToLocal(head.getWorldPosition(new THREE.Vector3()));
    // worldToLocal は配置の拡大縮小も戻すので、これでアバター本来の大きさでのずれになる
    const offset = eye.sub(headLocal);
    // おかしな値(モデルの設定ミス)は使わない。目は頭の骨の上・前、数cm〜十数cm
    return offset.length() < 0.3 ? offset : null;
  }

  /**
   * アバターの身長(足元から頭頂まで、m)。レスト姿勢の形の高さを測る。
   * リアルの身長を選んだときの比(アバターの身長 ÷ リアルの身長)に使う
   */
  function measureStature(target: Avatar): number | null {
    avatarRoot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(target.vrm.scene, true);
    if (box.isEmpty()) return null;
    const top = avatarRoot.worldToLocal(
      new THREE.Vector3(avatarRoot.position.x, box.max.y, avatarRoot.position.z),
    );
    return top.y > 0.3 ? top.y : null;
  }

  function setStatus(text: string): void {
    statusEl.textContent = text;
  }

  async function loadAvatar(url: string): Promise<void> {
    if (loading || url === currentUrl) return;
    loading = true;
    currentUrl = url;
    setStatus('アバターを読み込み中...');
    try {
      const next = await Avatar.load(url, avatarRoot, {
        precompile: { renderer, camera, scene },
      });
      const previous = avatar;
      previous?.detach();
      avatar = next;
      if (previous) requestAnimationFrame(() => previous.dispose());
      // 一人称表示の準備: 頭(髪・顔)を、自分の目からは見えない層と、他人からだけ見える層に分ける
      // (VRMの firstPerson の設定に従う)。どちらの層を映すかは applyViewLayers が決める
      next.vrm.firstPerson?.setup();
      applyViewLayers();
      updateXrLayout();
      // HMD配信の身長補正に使う(配信者の目の高さとの比を取る)
      broadcast.setAvatarHeight(next.restPose.height);
      broadcast.setAvatarEye(measureEyeOffset(next));
      const stature = measureStature(next);
      broadcast.setAvatarStature(stature);
      updateBodyTitles();
      options.onAvatarLoaded?.({
        height: next.restPose.height,
        stature,
        expressions: next.vrm.expressionManager?.expressions.map((e) => e.expressionName) ?? [],
      });
      setStatus('プレビュー中');
    } catch (error) {
      setStatus(`プレビューの読み込みに失敗: ${String(error)}`);
      currentUrl = null;
    } finally {
      loading = false;
    }
  }

  // 初期表示のアバターは呼び出し側(broadcast.ts)が「操作中の席」に合わせて
  // setAvatarUrl で流し込む(鏡がどの席を映すかはコンソールの席選択に従う)

  function resize(): void {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    renderer.setSize(width, height, false);
  }
  new ResizeObserver(resize).observe(canvas);
  resize();

  // ---- HMD配信 ----
  const check = (mode: 'immersive-ar' | 'immersive-vr'): Promise<boolean> =>
    navigator.xr?.isSessionSupported(mode).catch(() => false) ?? Promise.resolve(false);
  const hmdSupported = Promise.all([check('immersive-ar'), check('immersive-vr')]).then(
    ([ar, vr]) => ({ ar, vr }),
  );
  let xrSession: XRSession | null = null;

  // ---- 空間パネル(HMD中の操作。画面のボタンを押せないため) ----
  const handle: PreviewHandle = {
    setAvatarUrl: (url) => void loadAvatar(url),
    applyPeer: (id, state) => peers.apply(id, state),
    removePeer: (id) => peers.remove(id),
    clearPeers: () => peers.clear(),
    setStatus,
    enterHmd,
    exitHmd,
    hmdSupported,
    setMirrorVisible,
    onMicToggle: null,
    onBroadcastStart: null,
    onBroadcastStop: null,
    setBroadcastLabel: (on) => panel.setActive(on ? 'broadcast-on' : 'broadcast-off'),
    onWristChange: null,
    onWristReset: null,
    // 見出しは欄を番号ではなく中身で探して書き換える(欄を足すと番号がずれ、別の欄の見出しを上書きしていた)
    setWristLabel: (text) => panel.setSectionTitle(wristSection, text),
    setMicLabel: (on) => {
      panel.setActive(on ? 'mic-on' : 'mic-off');
      micToggling = false;
      pulseMic(on);
    },
    setMicTrack: (track) => micLipSync.setTrack(track),
    setLocalPose: (source) => (localPose = source),
  };

  const panelSections: PanelSection[] = [
      {
        title: 'アバター',
        tab: '体',
        options: [{ label: '位置を合わせ直す', value: 'recalibrate', action: true }],
        initial: '',
        onSelect: () => {
          broadcast.recalibrate();
          setStatus('位置を合わせ直しています...');
        },
      },
      {
        // 自分に入る: VRChat のように、アバターを自分の体に重ねる(下を向くと自分の体が見える)。
        // 鏡で見る: 右前方に立つアバターで、視聴者から見た自分を確かめる
        // 自分＋鏡: 自分に入ったまま、右前方の姿見に自分の姿が映る(VRChat の鏡と同じ)。
        // アバターを前に: 右前方にアバターを立たせて、視聴者から見た自分を確かめる
        title: '視点',
        tab: '視点',
        columns: 2,
        options: [
          { label: '自分に入る', value: 'view-first' },
          { label: '自分＋鏡', value: 'view-first-mirror' },
          { label: 'アバターを前に', value: 'view-front' },
          { label: '隠す', value: 'view-hidden' },
        ],
        initial: 'view-first',
        onSelect: (value) => {
          viewMode =
            value === 'view-first'
              ? 'first'
              : value === 'view-first-mirror'
                ? 'first-mirror'
                : value === 'view-front'
                  ? 'front'
                  : 'hidden';
          setMirrorVisible(viewMode !== 'hidden');
          applyViewLayers();
          updateXrLayout();
        },
      },
      {
        // VRChat の立ちモード・座りモード。切り替えると位置を合わせ直す
        title: '姿勢',
        tab: '体',
        columns: 2,
        options: [
          { label: '立って遊ぶ', value: 'play-standing' },
          { label: '座って遊ぶ', value: 'play-seated' },
        ],
        initial: broadcast.playMode === 'seated' ? 'play-seated' : 'play-standing',
        onSelect: (value) => {
          broadcast.setPlayMode(value === 'play-seated' ? 'seated' : 'standing');
          setStatus('位置を合わせ直しています...');
        },
      },
      {
        // リアルの身長。選ぶと、身長の比を「アバターの身長 ÷ リアルの身長」で決める(姿勢に左右されない)
        title: '身長',
        tab: '体',
        columns: 4,
        options: [
          { label: '−5', value: 'height--5', action: true },
          { label: '−1', value: 'height--1', action: true },
          { label: '＋1', value: 'height-1', action: true },
          { label: '＋5', value: 'height-5', action: true },
          { label: '自動', value: 'height-auto', action: true },
        ],
        initial: '',
        onSelect: (value) => {
          const body = broadcast.bodySettings;
          if (value === 'height-auto') {
            broadcast.setBodySettings({ ...body, realHeight: null });
            return;
          }
          const base = body.realHeight ?? broadcast.estimatedRealHeight();
          const step = Number(value.slice('height-'.length)) / 100;
          broadcast.setBodySettings({ ...body, realHeight: Math.round((base + step) * 100) / 100 });
        },
      },
      {
        // 目線の高さ(OVR の空間の高さのオフセットと同じ)。大きさは変えずに、自分の追跡位置ごと上下にずらす。
        // 下げると膝が曲がり、上げると浮く
        title: '目線',
        tab: '体',
        columns: 5,
        options: [
          { label: '−5', value: 'shift--5', action: true },
          { label: '−1', value: 'shift--1', action: true },
          { label: '0', value: 'shift-0', action: true },
          { label: '＋1', value: 'shift-1', action: true },
          { label: '＋5', value: 'shift-5', action: true },
        ],
        initial: '',
        onSelect: (value) => {
          const body = broadcast.bodySettings;
          const step = Number(value.slice('shift-'.length)) / 100;
          const heightShift = step === 0 ? 0 : body.heightShift + step;
          broadcast.setBodySettings({ ...body, heightShift: Math.round(heightShift * 100) / 100 });
        },
      },
      {
        // 軸ごとに −/＋ を別のボタンにする(1つのボタンで一周させると、戻すのに何回も押す必要があった)
        title: '手首',
        tab: '手首',
        columns: 2,
        options: [
          { label: 'X −15°', value: 'wrist-x-', action: true },
          { label: 'X ＋15°', value: 'wrist-x+', action: true },
          { label: 'Y −15°', value: 'wrist-y-', action: true },
          { label: 'Y ＋15°', value: 'wrist-y+', action: true },
          { label: 'Z −15°', value: 'wrist-z-', action: true },
          { label: 'Z ＋15°', value: 'wrist-z+', action: true },
          { label: '既定に戻す', value: 'wrist-reset', action: true },
        ],
        initial: '',
        onSelect: (value) => {
          if (value === 'wrist-reset') {
            handle.onWristReset?.();
            return;
          }
          const axis = value.charAt(6) as 'x' | 'y' | 'z';
          handle.onWristChange?.(axis, value.endsWith('+') ? 15 : -15);
        },
      },
      {
        // 「手で切替」はジェスチャーに割り当てた表情、ほかは選んだ表情に固定(ジェスチャーより優先)
        title: '表情',
        tab: '表情',
        columns: 3,
        options: [
          { label: '手で切替', value: 'gesture' },
          { label: '喜', value: 'happy' },
          { label: '怒', value: 'angry' },
          { label: '哀', value: 'sad' },
          { label: '楽', value: 'relaxed' },
          { label: '驚', value: 'surprised' },
        ],
        initial: 'gesture',
        onSelect: (value) => broadcast.setExpressionOverride(value === 'gesture' ? null : value),
      },
      {
        title: 'マイク',
        tab: '配信',
        columns: 2,
        options: [
          { label: 'ON', value: 'mic-on' },
          { label: 'OFF', value: 'mic-off' },
        ],
        initial: 'mic-on',
        onSelect: () => handle.onMicToggle?.(),
      },
      {
        // VRに入るのと配信は別。入ったあと、ここで始める(入った瞬間から映らないように)
        title: '配信',
        tab: '配信',
        columns: 2,
        options: [
          { label: '配信を開始', value: 'broadcast-on' },
          { label: '配信を停止', value: 'broadcast-off' },
        ],
        initial: 'broadcast-off',
        onSelect: (value) =>
          value === 'broadcast-on' ? handle.onBroadcastStart?.() : handle.onBroadcastStop?.(),
      },
      {
        title: 'VR',
        tab: '配信',
        options: [{ label: 'VRを終了する', value: 'exit', action: true }],
        initial: '',
        onSelect: () => exitHmd(),
      },
  ];
  const wristSection = panelSections.findIndex((section) => section.title === '手首');
  const avatarSection = panelSections.findIndex((section) => section.title === 'アバター');
  const heightSection = panelSections.findIndex((section) => section.title === '身長');
  const eyeSection = panelSections.findIndex((section) => section.title === '目線');
  // 操作パネルはタブに分けて、手に載せる(VRChat のクイックメニューのように。handMenu.ts)
  const panel = new SpatialPanel({
    title: 'メニュー(B/Yで開閉)',
    tabs: ['配信', '視点', '表情', '体', '手首'],
    sections: panelSections,
    width: 0.28,
    anchor: 'bottom',
  });

  /** 身長・目線の欄の見出しに、いまの値を出す(VRの中からは配信者ページが見えないため) */
  function updateBodyTitles(): void {
    const body = broadcast.bodySettings;
    const stature = broadcast.avatarStature;
    const avatarText = stature ? `(アバター${Math.round(stature * 100)}cm)` : '';
    panel.setSectionTitle(
      heightSection,
      `身長 ${body.realHeight ? `${Math.round(body.realHeight * 100)}cm` : '自動'} ${avatarText}`,
    );
    const shift = Math.round(body.heightShift * 100);
    panel.setSectionTitle(
      eyeSection,
      `目線の高さ ${shift > 0 ? '＋' : shift < 0 ? '−' : '±'}${Math.abs(shift)}cm`,
    );
  }
  broadcast.bodyListeners.push(updateBodyTitles);
  // 目線の高さは合わせ直さずに効くので、周りの世界の置き場所もその場で動かす
  broadcast.bodyListeners.push(() => updateXrLayout());
  updateBodyTitles();
  // 合わせ直すまでの秒読みを、アバターの欄の見出しに出す
  broadcast.onCalibrationCountdown = (seconds) =>
    panel.setSectionTitle(avatarSection, seconds ? `位置合わせまで ${seconds}…` : 'アバター');
  const panelController = new XrPanelController(renderer, scene, [panel]);
  const handMenu = new HandMenu(panel);
  /** VRに入って最初の位置合わせで、左手にメニューを開いて置き場所を知らせる */
  let menuIntroduced = false;

  async function enterHmd(mode: XrMode): Promise<void> {
    if (xrSession) return;
    startedAt = performance.now();
    firstXrFrameAt = null;
    const session = await navigator.xr!.requestSession(
      mode === 'ar' ? 'immersive-ar' : 'immersive-vr',
      // hand-tracking は要求しないと素手の関節が取れない(コントローラだけになる)。
      // body-tracking は Quest の実験機能で、開始時に許可を求められる
      { optionalFeatures: ['local-floor', 'hand-tracking', 'body-tracking'] },
    );
    logStartup('VRのセッション開始');
    xrSession = session;
    // パススルーでは背景を消して現実を見せる。VRは暗い背景とグリッドを残す
    scene.background = mode === 'ar' ? null : backgroundColor;
    grid.visible = mode === 'vr';

    // 先に描画を始める。SFUへの接続(DataChannel が開くまで数秒〜十数秒かかることがある)を
    // 待ってからだと、その間ヘッドセットへ1枚も絵を送れず、頭もコントローラも止まって見える。
    // 接続は描画を始めてから裏で進め、つながるまでは送らないだけにする(sendFrame は接続前なら何もしない)。
    // VRのセッションの要求より前に接続を始める版は、実機でトラッキングが始まらなくなったので戻した
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    turnArmed = true;
    panel.setActive('broadcast-off');
    applyViewLayers();
    setStatus('VRに入りました。左手のメニュー(B/Yで開閉・手のひらを顔に向けても開く)の「配信を開始」で配信が始まります');
    // トリガーでの位置合わせはやめた(パネルを押すつもりで合わせ直してしまい、混乱するため)。
    // 合わせ直しはパネルの「位置を合わせ直す」で行う
    session.addEventListener('end', () => {
      xrSession = null;
      broadcast.close();
      panelController.hide();
      handMenu.close();
      menuIntroduced = false;
      scene.background = backgroundColor;
      grid.visible = true;
      avatarRoot.position.set(0, 0, 0);
      avatarRoot.quaternion.identity();
      setAvatarScale(1);
      avatarRoot.visible = true;
      grid.position.set(0, 0, 0);
      grid.quaternion.identity();
      grid.scale.setScalar(1);
      applyViewLayers();
      showMirror(false);
      setStatus('HMD配信を終了しました');
    });
  }

  /**
   * VRの開始にかかった時間。ボタンを押してから「VRのセッション開始」「最初の絵」「配信開始」までを
   * コンソールと状態表示に出す(開始が遅いとき、どこで待っているかを見分ける手がかり)
   */
  let startedAt = 0;
  let firstXrFrameAt: number | null = null;
  const startupSteps: string[] = [];
  function logStartup(step: string): void {
    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    console.info(`[hmd] ${step}: ${seconds}秒`);
    if (step === 'VRのセッション開始') startupSteps.length = 0;
    startupSteps.push(`${step} ${seconds}秒`);
    setStatus(`HMD配信: ${startupSteps.join(' → ')}`);
  }

  /**
   * 右スティックで旋回する(左右に倒すたびに SNAP_TURN ずつ。なめらかに回すより酔いにくい)。
   * 立っている場所を中心に、基準の空間(reference space)を回す。HMD配信は、その空間での姿勢を
   * 開始時の向きからの差分で送るので、回った分だけアバターもその向きを向く
   */
  const SNAP_TURN = Math.PI / 6;
  /** 倒したと判定する量と、戻したと判定する量(倒しっぱなしで回り続けないように) */
  const TURN_PUSH = 0.7;
  const TURN_RELEASE = 0.3;
  let turnArmed = true;
  const _turnQuat = new THREE.Quaternion();
  /**
   * 左のコントローラのボタン(メニューを開かずに使う):
   * - X: マイクのミュートと復帰。切り替わったら震えて知らせる(オン: 1回、オフ: 2回)
   * - スティックの押し込み: 押している間、手を上下に動かして目線の高さを合わせる(前後左右の動きは無視)。
   *   手を下げると目線が上がり、上げると下がる(床をつかんで動かす感覚)。手の動きと同じ量だけ動くので、
   *   ミリ単位で合わせられる。1cm 動くごとに軽く震える
   */
  const MIC_BUTTON = 4;
  const HEIGHT_GRAB_BUTTON = 3;
  let micButtonDown = false;
  /** 切り替えの途中(マイクの開始には少しかかる)は、押しても受け付けない */
  let micToggling = false;
  /** 目線の高さを合わせている間の、押し込んだときの手の高さと目線の高さ */
  let heightGrab: { handY: number; shift: number; lastCm: number } | null = null;
  function handleLeftButtons(frame: XRFrame, refSpace: XRReferenceSpace): void {
    const session = xrSession;
    if (!session) return;
    let grabbing = false;
    for (const source of session.inputSources) {
      if (source.handedness !== 'left' || source.hand || !source.gamepad) continue;
      const buttons = source.gamepad.buttons;
      const pressed = buttons[MIC_BUTTON]?.pressed ?? false;
      if (pressed && !micButtonDown && !micToggling && handle.onMicToggle) {
        micToggling = true;
        handle.onMicToggle();
      }
      micButtonDown = pressed;

      if (!(buttons[HEIGHT_GRAB_BUTTON]?.pressed ?? false) || !source.gripSpace) continue;
      const pose = frame.getPose(source.gripSpace, refSpace);
      if (!pose) continue;
      grabbing = true;
      const handY = pose.transform.position.y;
      if (!heightGrab) {
        heightGrab = { handY, shift: broadcast.bodySettings.heightShift, lastCm: 0 };
        pulseLeft(0.3, 30);
        continue;
      }
      // 手を下げた分だけ目線を上げる。1mm より細かい揺れでは設定を書き換えない(保存と見出しの描き直しが毎フレーム走るため)
      const shift = Math.round((heightGrab.shift + (heightGrab.handY - handY)) * 1000) / 1000;
      const body = broadcast.bodySettings;
      if (Math.abs(shift - body.heightShift) >= 0.001) {
        broadcast.setBodySettings({ ...body, heightShift: shift });
        const cm = Math.trunc((broadcast.bodySettings.heightShift - heightGrab.shift) * 100);
        if (cm !== heightGrab.lastCm) {
          heightGrab.lastCm = cm;
          pulseLeft(0.15, 15);
        }
      }
    }
    if (!grabbing) heightGrab = null;
  }
  function pulseLeft(value: number, duration: number): void {
    const session = xrSession;
    if (!session) return;
    for (const source of session.inputSources) {
      if (source.handedness !== 'left' || source.hand) continue;
      const actuator = source.gamepad?.hapticActuators?.[0] as
        | { pulse?: (value: number, duration: number) => Promise<boolean> }
        | undefined;
      void actuator?.pulse?.(value, duration);
    }
  }
  function pulseMic(on: boolean): void {
    pulseLeft(0.6, 80);
    if (!on) window.setTimeout(() => pulseLeft(0.6, 80), 180);
  }

  function handleSnapTurn(frame: XRFrame): void {
    const session = xrSession;
    const space = renderer.xr.getReferenceSpace();
    if (!session || !space) return;
    let x = 0;
    for (const source of session.inputSources) {
      if (source.handedness !== 'right' || !source.gamepad) continue;
      const axes = source.gamepad.axes;
      // xr-standard: 2,3 がスティック(0,1 はタッチパッド)。スティックしか無い端末は 0,1
      x = axes.length >= 4 ? (axes[2] ?? 0) : (axes[0] ?? 0);
    }
    if (!turnArmed) {
      if (Math.abs(x) < TURN_RELEASE) turnArmed = true;
      return;
    }
    if (Math.abs(x) < TURN_PUSH) return;
    const viewer = frame.getViewerPose(space);
    if (!viewer) return;
    turnArmed = false;
    // 頭の真下を中心に回す: その点へ移る → 回す → 戻る。右へ倒すと右を向く
    const p = viewer.transform.position;
    _turnQuat.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sign(x) * SNAP_TURN);
    const turned = space
      .getOffsetReferenceSpace(new XRRigidTransform({ x: p.x, y: 0, z: p.z }))
      .getOffsetReferenceSpace(
        new XRRigidTransform(undefined, {
          x: _turnQuat.x,
          y: _turnQuat.y,
          z: _turnQuat.z,
          w: _turnQuat.w,
        }),
      )
      .getOffsetReferenceSpace(new XRRigidTransform({ x: -p.x, y: 0, z: -p.z }));
    renderer.xr.setReferenceSpace(turned);
  }

  function exitHmd(): void {
    void xrSession?.end();
  }

  /** 鏡(自分の姿)。正面を空けたいときは消せる(位置の更新は続ける) */
  function setMirrorVisible(on: boolean): void {
    avatarRoot.visible = on;
  }

  /**
   * HMD配信中の配置。
   * 視聴者は「配信者自身」を基準に、鏡は正面を避けて右前方へ置く
   * (視聴者と重なるとハイタッチの邪魔になる)
   */
  const _mirrorOffset = new THREE.Vector3();
  const _mirrorTarget = new THREE.Vector3();
  /** VRでの自分のアバターの見せ方(パネルの「視点」) */
  let viewMode: 'first' | 'first-mirror' | 'front' | 'hidden' = 'first';
  const isInside = (): boolean => viewMode === 'first' || viewMode === 'first-mirror';

  /**
   * 姿見(自分＋鏡)。three.js の Reflector で、鏡に映した視点からシーンを描く。VRでは目ごとに描き直すので
   * 重くなる。そのため選んでいるときだけシーンに置く。鏡には「他人から見た」層(頭のある体)を映すので、
   * 自分の視界に髪がかからないまま、鏡の中には顔まで映る
   */
  const MIRROR_WIDTH = 1.0;
  const MIRROR_HEIGHT = 1.7;
  let mirror: Reflector | null = null;
  function showMirror(on: boolean): void {
    if (!on) {
      if (mirror) scene.remove(mirror);
      return;
    }
    if (!mirror) {
      mirror = new Reflector(new THREE.PlaneGeometry(MIRROR_WIDTH, MIRROR_HEIGHT), {
        textureWidth: 1024,
        textureHeight: Math.round((1024 * MIRROR_HEIGHT) / MIRROR_WIDTH),
        color: 0xc8c8c8,
      });
    }
    mirror.camera.layers.set(0);
    mirror.camera.layers.enable(
      avatar?.vrm.firstPerson?.thirdPersonOnlyLayer ??
        VRMFirstPerson.DEFAULT_THIRDPERSON_ONLY_LAYER,
    );
    scene.add(mirror);
  }

  function setAvatarScale(scale: number): void {
    if (avatarRoot.scale.x === scale) return;
    avatarRoot.scale.setScalar(scale);
    // 揺れもの(髪・スカート)の長さも配置の大きさに合わせる
    avatar?.applyScale(scale);
  }

  /**
   * カメラに映す層。自分に入っているときは「自分の目から見た」層(頭を消した体)、
   * それ以外(鏡・画面のプレビュー)は「他人から見た」層(頭のある体)を映す
   */
  function applyViewLayers(): void {
    const firstPerson = avatar?.vrm.firstPerson;
    if (!firstPerson) return;
    const inside = xrSession !== null && isInside();
    camera.layers.set(0);
    camera.layers.enable(
      inside ? firstPerson.firstPersonOnlyLayer : firstPerson.thirdPersonOnlyLayer,
    );
  }

  /**
   * VRでの配置。アバター・視聴者・鏡・床は、まとめて「ワイヤの世界」として置く:
   * ワイヤ座標を現実へ戻す変換(足元・向き・座りモードの持ち上げ・1/身長の比)を全部に同じく掛ける。
   * VRChat と同じく、アバターは本来の大きさのまま、周りの世界ごと自分の身長に合わせて見える
   * (以前はアバターだけを拡大縮小していたので、鏡や視聴者との大きさの感じが合わなかった)
   */
  function updateXrLayout(): void {
    if (!xrSession || !broadcast.getWireToXr(peerRoot)) {
      showMirror(false);
      return;
    }
    peerRoot.updateMatrixWorld();
    const worldScale = peerRoot.scale.x;
    if (grid.visible) {
      // 床もワイヤの世界の床(座りモードでは、アバターが立つ床が現実の床より下になる)
      grid.position.copy(peerRoot.position);
      grid.quaternion.copy(peerRoot.quaternion);
      grid.scale.setScalar(worldScale);
    }
    showMirror(viewMode === 'first-mirror');
    if (mirror && viewMode === 'first-mirror') {
      // 右前方の床に立てた姿見。ワイヤ座標は「正面=+Z、右=-X」。下端が床から少し浮く高さにし、配信者の方へ向ける
      mirror.position.copy(peerRoot.localToWorld(_mirrorOffset.set(-0.8, MIRROR_HEIGHT / 2 + 0.05, 1.3)));
      mirror.scale.setScalar(worldScale);
      _mirrorTarget.copy(peerRoot.position).setY(mirror.position.y);
      mirror.lookAt(_mirrorTarget);
    }
    setAvatarScale(worldScale);
    if (isInside()) {
      // 自分に入る: ワイヤの世界の原点にそのまま置くと、アバターの目が自分の目、手がコントローラに重なる
      avatarRoot.position.copy(peerRoot.position);
      avatarRoot.quaternion.copy(peerRoot.quaternion);
      return;
    }
    // アバターを前に: ワイヤ座標で右前方 (-x, +z) に立たせ、配信者の方を向かせる(avatarRootは+Zが正面)
    avatarRoot.position.copy(peerRoot.localToWorld(_mirrorOffset.set(-1.0, 0, 1.5)));
    avatarRoot.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.atan2(
        peerRoot.position.x - avatarRoot.position.x,
        peerRoot.position.z - avatarRoot.position.z,
      ),
    );
  }

  const clock = new THREE.Clock();
  /**
   * 毎フレームの処理。three.js(0.172)の描画ループは、処理の中でエラーが1回でも起きると
   * 次のフレームを予約しないまま止まる。VRでは絵が固まり、頭もコントローラも動かなくなったように
   * 見えるので、エラーは記録して次のフレームへ進む(同じエラーを毎フレーム書かないよう間引く)
   */
  let lastFrameErrorAt = 0;
  renderer.setAnimationLoop((time: number, frame?: XRFrame) => {
    try {
      renderFrame(time, frame);
    } catch (error) {
      const now = performance.now();
      if (now - lastFrameErrorAt > 5000) {
        lastFrameErrorAt = now;
        console.error('[preview] フレームの処理でエラー(描画は続けます):', error);
        setStatus(`処理中にエラーが起きました(続けています): ${String(error)}`);
      }
      // エラーの起きたフレームでも絵は出す(出さないとVRで画面が固まる)
      try {
        renderer.render(scene, camera);
      } catch {
        // 描画そのものが失敗したときは、次のフレームでやり直す
      }
    }
  });

  function renderFrame(_time: number, frame?: XRFrame): void {
    const delta = clock.getDelta();
    const now = performance.now();
    peers.update();
    // 手に載せたメニューを先に動かしてから、ビームの当たりを調べる
    if (frame && xrSession) {
      const refSpace = renderer.xr.getReferenceSpace();
      if (refSpace) handMenu.update(frame, refSpace, xrSession);
    }
    panelController.exclude = handMenu.holder;
    panelController.update();

    // HMDで入っている間は自分の姿勢を配信する
    if (frame && xrSession && firstXrFrameAt === null) {
      firstXrFrameAt = performance.now();
      logStartup('最初の絵');
    }
    if (frame && xrSession) {
      handleSnapTurn(frame);
      const refSpace = renderer.xr.getReferenceSpace();
      if (refSpace) handleLeftButtons(frame, refSpace);
      if (refSpace) {
        if (!broadcast.calibrated) {
          const viewer = frame.getViewerPose(refSpace);
          if (viewer && broadcast.tryCalibrate(viewer)) {
            updateXrLayout();
            // メニューは手に載せるので、置き場所は決めずに押せるようにだけする
            panelController.enable();
            if (!menuIntroduced) {
              menuIntroduced = true;
              handMenu.open('left');
            }
          }
        } else {
          broadcast.sendFrame(frame, refSpace, xrSession);
        }
      }
    } else {
      // 画面で見ているときは、視聴者をアバターの周りに置く
      peerRoot.position.copy(avatarRoot.position);
      peerRoot.quaternion.copy(avatarRoot.quaternion);
      peerRoot.scale.setScalar(1);
    }

    if (avatar) {
      // 手元の姿勢: Webカメラ配信中ならその推定、VRの中ならヘッドセットとコントローラ。
      // 届いた姿を待たずに当てる(配信前でも動き、もたつかない)
      const localFrame = localPose?.() ?? (xrSession ? broadcast.localFrame() : null);
      const liveFrame = localFrame ?? player.sample(now);
      const live =
        Boolean(liveFrame.pose) && (localFrame !== null || now - lastPacketAt < IDLE_AFTER_MS);
      const step = delta * (1000 / IDLE_BLEND_MS);
      liveBlend = THREE.MathUtils.clamp(liveBlend + (live ? step : -step), 0, 1);

      if (liveBlend >= 1) {
        avatar.applyPose(liveFrame);
      } else {
        const idleFrame = idleMotion.sample(now, avatar.restPose);
        avatar.applyPose(liveBlend > 0 ? blendPose(idleFrame, liveFrame, liveBlend) : idleFrame);
      }
      // 自分のマイクの音で口を動かす。視聴側(AvatarUnit)と同じく、音がある間は
      // 口(母音)をリップシンクが所有して毎フレーム直接セットする
      const expressions = avatar.vrm.expressionManager;
      const lipSync = micLipSync.sample(delta);
      if (expressions && lipSync) {
        lipSyncActive = true;
        for (const [name, value] of Object.entries(lipSync)) expressions.setValue(name, value);
      } else if (expressions && lipSyncActive) {
        lipSyncActive = false;
        for (const name of ['aa', 'ih', 'ou', 'ee', 'oh']) expressions.setValue(name, 0);
      }
      avatar.update(delta);
    }

    controls.update();
    renderer.render(scene, camera);
  }

  return handle;
}
