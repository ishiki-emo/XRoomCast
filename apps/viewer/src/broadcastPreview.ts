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
import { decodePacket } from '@xroomcast/protocol';
import { Avatar } from '@xroomcast/viewer-core';
import type { AuthProvider, SampledFrame } from '@xroomcast/sync';
import type { HmdBroadcast } from './hmdBroadcast';
import { IdleMotion, blendPose } from '@xroomcast/viewer-core';
import { PeerPresence, type PeerState } from '@xroomcast/viewer-core';
import { PoseStreamPlayer } from '@xroomcast/sync';
import { SfuTransport } from '@xroomcast/sync';
import { SpatialPanel } from './spatialUI';
import { XrPanelController } from './xrPanelController';
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
  onWristChange: ((axis: 'x' | 'y' | 'z', delta: number) => void) | null;
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
  /** アバターを読み込んだとき(頭の高さ)。Webカメラ配信の頭の位置の基準に使う */
  onAvatarHeight?: (height: number) => void;
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
      // HMD配信の身長補正に使う(配信者の目の高さとの比を取る)
      broadcast.setAvatarHeight(next.restPose.height);
      options.onAvatarHeight?.(next.restPose.height);
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
    onWristChange: null,
    setWristLabel: (text) => panel.setSectionTitle(1, text),
    setMicLabel: (on) => panel.setActive(on ? 'mic-on' : 'mic-off'),
    setMicTrack: (track) => micLipSync.setTrack(track),
    setLocalPose: (source) => (localPose = source),
  };

  const panel = new SpatialPanel({
    title: '配信',
    sections: [
      {
        title: 'アバター',
        options: [
          { label: '位置を合わせ直す', value: 'recalibrate', action: true },
          { label: '鏡を表示', value: 'mirror-on' },
          { label: '鏡を隠す', value: 'mirror-off' },
        ],
        initial: 'mirror-on',
        onSelect: (value) => {
          if (value === 'recalibrate') {
            broadcast.recalibrate();
            setStatus('位置を合わせ直しています...');
          } else {
            setMirrorVisible(value === 'mirror-on');
          }
        },
      },
      {
        title: '手首',
        options: [
          { label: 'X −15 / ＋15', value: 'wrist-x', action: true },
          { label: 'Y −15 / ＋15', value: 'wrist-y', action: true },
          { label: 'Z −15 / ＋15', value: 'wrist-z', action: true },
        ],
        initial: '',
        // 同じボタンで送り、一周したら戻る(空間では細かいボタンを増やしにくい)
        onSelect: (value) => handle.onWristChange?.(value.slice(-1) as 'x' | 'y' | 'z', 15),
      },
      {
        title: 'マイク',
        options: [
          { label: 'ON', value: 'mic-on' },
          { label: 'OFF', value: 'mic-off' },
        ],
        initial: 'mic-on',
        onSelect: () => handle.onMicToggle?.(),
      },
      {
        title: '配信',
        options: [{ label: '終了する', value: 'exit', action: true }],
        initial: '',
        onSelect: () => exitHmd(),
      },
    ],
  });
  // 鏡は右前方に出すので、パネルは左前方の手が届く距離へ(向きはshow()が合わせる)
  panel.arPlacement = { position: new THREE.Vector3(0.45, 1.15, 0.7), yaw: 0 };
  const panelController = new XrPanelController(renderer, scene, [panel]);

  async function enterHmd(mode: XrMode): Promise<void> {
    if (xrSession) return;
    const session = await navigator.xr!.requestSession(
      mode === 'ar' ? 'immersive-ar' : 'immersive-vr',
      // hand-tracking は要求しないと素手の関節が取れない(コントローラだけになる)。
      // body-tracking は Quest の実験機能で、開始時に許可を求められる
      { optionalFeatures: ['local-floor', 'hand-tracking', 'body-tracking'] },
    );
    xrSession = session;
    // パススルーでは背景を消して現実を見せる。VRは暗い背景とグリッドを残す
    scene.background = mode === 'ar' ? null : backgroundColor;
    grid.visible = mode === 'vr';

    await broadcast.connect();
    renderer.xr.setReferenceSpaceType('local-floor');
    await renderer.xr.setSession(session);
    // パネルを指していないときのトリガーは位置合わせに使う
    session.addEventListener('select', (event) => {
      if (panelController.pointing) return;
      // 素手のピンチは身振りの途中でも起きるため、合わせ直しには使わない
      // (素手のときはパネルの「位置を合わせ直す」を使う)
      if (event.inputSource.hand) return;
      broadcast.recalibrate();
      setStatus('位置を合わせ直しています...');
    });
    session.addEventListener('end', () => {
      xrSession = null;
      broadcast.close();
      panelController.hide();
      scene.background = backgroundColor;
      grid.visible = true;
      avatarRoot.position.set(0, 0, 0);
      avatarRoot.quaternion.identity();
      avatarRoot.visible = true;
      setStatus('HMD配信を終了しました');
    });
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
  function updateXrLayout(): void {
    if (!broadcast.getWireToXr(peerRoot)) return;
    peerRoot.updateMatrixWorld();
    // ワイヤ座標は「正面=+Z、右=-X」。右前方は (-x, +z) になる
    _mirrorOffset.set(-1.0, 0, 1.5).applyQuaternion(peerRoot.quaternion);
    avatarRoot.position.copy(peerRoot.position).add(_mirrorOffset);
    // 鏡なので配信者の方を向かせる。avatarRootは+Zが正面(視聴ページの設置と同じ)
    avatarRoot.quaternion.setFromAxisAngle(
      new THREE.Vector3(0, 1, 0),
      Math.atan2(
        peerRoot.position.x - avatarRoot.position.x,
        peerRoot.position.z - avatarRoot.position.z,
      ),
    );
  }

  const clock = new THREE.Clock();
  renderer.setAnimationLoop((_time: number, frame?: XRFrame) => {
    const delta = clock.getDelta();
    const now = performance.now();
    peers.update();
    panelController.update();

    // HMDで入っている間は自分の姿勢を配信する
    if (frame && xrSession) {
      const refSpace = renderer.xr.getReferenceSpace();
      if (refSpace) {
        if (!broadcast.calibrated) {
          const viewer = frame.getViewerPose(refSpace);
          if (viewer) {
            broadcast.calibrate(viewer);
            updateXrLayout();
            // パネルも配信者の前方へ出し直す
            panelController.show(peerRoot.position, Math.atan2(
              2 * (peerRoot.quaternion.w * peerRoot.quaternion.y),
              1 - 2 * peerRoot.quaternion.y * peerRoot.quaternion.y,
            ));
          }
        } else {
          broadcast.sendFrame(frame, refSpace, xrSession);
        }
      }
    } else {
      // 画面で見ているときは、視聴者をアバターの周りに置く
      peerRoot.position.copy(avatarRoot.position);
      peerRoot.quaternion.copy(avatarRoot.quaternion);
    }

    if (avatar) {
      const localFrame = localPose?.() ?? null;
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
  });

  return handle;
}
