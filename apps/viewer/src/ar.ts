/**
 * WebXRパススルーAR(immersive-ar)。
 * - 対応端末(Androidスマホ/Quest/PICO等)でのみボタンを表示する
 * - ヒットテストで床にレティクルを出し、トリガー(select)で設置
 * - グリップ(squeeze)でアバターをつかんで移動、両手グリップで伸縮+回転(卓上モード)
 * - 設置・つかみ・スケールはすべて roomSpace(部屋の配置フレーム)の変換として行う。
 *   アバターや将来の複数配信者はその子なので部屋ごと動き、
 *   PoseApplierがフレーム対応なので、IK・足接地・ルートモーションは壊れない
 *
 * 互換性メモ: 一部ブラウザ(PICO等)はselectイベントのXRFrameでヒットテスト
 * 結果を返さないため、rAFフレームで結果をキャッシュして設置時に使う。
 */
import * as THREE from 'three';
import { ArLighting } from './arLighting';
import {
  DEPTH_SENSING_INIT,
  depthDescription,
  depthInfoLines,
  shouldRequestDepth,
  updateDepthOcclusion,
} from './depthOcclusion';
import type { ArPanel } from './spatialUI';
import { TouchAR } from './touchAR';

export interface ArElements {
  button: HTMLButtonElement;
  overlayRoot: HTMLElement;
  hint: HTMLElement;
  exitButton: HTMLButtonElement;
  touch: HTMLElement;
}

const SCALE_MIN = 0.1;
const SCALE_MAX = 2.5;
const LASER_DEFAULT_LEN = 1.5;
/** AR開始時にアバターを置く距離(視線の前方・メートル) */
const INITIAL_PLACE_DISTANCE = 1.2;
/**
 * 描画バッファ倍率の上限。負荷は倍率の二乗で効くので、上げすぎると
 * 発熱とフレーム落ちを招く
 */
const MAX_FRAMEBUFFER_SCALE = 4;
/** 初回の倍率。端末の「推奨」が極端に低い環境があるので、控えめに上げて始める */
const INITIAL_FRAMEBUFFER_SCALE = 2;
/** 次回に使う倍率の保存先(倍率はセッション開始時にしか変えられないため) */
const SCALE_STORAGE_KEY = 'xroomcast.xrFramebufferScale';

const clampScale = (value: number): number =>
  Math.min(Math.max(value, 1), MAX_FRAMEBUFFER_SCALE);

/**
 * 次の描画フレームまで待つ(レイアウトの反映待ち)。
 * requestAnimationFrame が来ない状況で固まらないよう、時間でも打ち切る
 */
function nextLayoutFrame(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    requestAnimationFrame(() => finish());
    window.setTimeout(finish, 100);
  });
}

/**
 * 使う描画バッファ倍率。`?xrscale=` があればそれを優先する(検証用)。
 * 無ければ前回セッションで算出した値、それも無ければ初期値
 */
function preferredFramebufferScale(): number {
  const param = Number(new URLSearchParams(location.search).get('xrscale'));
  if (Number.isFinite(param) && param > 0) return clampScale(param);
  try {
    const stored = Number(localStorage.getItem(SCALE_STORAGE_KEY));
    if (Number.isFinite(stored) && stored > 0) return clampScale(stored);
  } catch {
    // localStorageが使えない環境では初期値のまま
  }
  return INITIAL_FRAMEBUFFER_SCALE;
}
const UP_AXIS = new THREE.Vector3(0, 1, 0);

const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();
const _raycaster = new THREE.Raycaster();

type GrabTarget = null | 'avatar' | 'panel';
interface RayHit {
  panel: ArPanel | null;
  index: number; // >=0 ボタン, -2 パネル面(ボタン外), -1 なし
  distance: number;
}

export class ArController {
  /** スケールが変わったときに呼ばれる(スプリングボーン等の追従用) */
  onScaleChanged: ((scale: number) => void) | null = null;
  /** 照明推定の開始・終了で、既定のライトへ掛ける倍率が変わったときに呼ばれる */
  onDefaultLightScale: ((scale: number) => void) | null = null;
  private readonly lighting: ArLighting;
  /**
   * AR開始時、DOMオーバーレイが実際に有効かを通知する。
   * true(スマホ)なら画面固定のUIを、false(HMD)なら空間パネルを使う
   */
  onOverlayModeChange: ((domOverlayActive: boolean) => void) | null = null;

  private session: XRSession | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private readonly reticle: THREE.Mesh;

  /** rAFフレームでキャッシュした床ヒット位置と視点位置(select時に使用) */
  private latestHit: THREE.Vector3 | null = null;
  private readonly latestViewer = new THREE.Vector3();

  // ---- つかみ状態 ----
  private readonly grips: THREE.XRGripSpace[];
  private readonly controllers: THREE.XRTargetRaySpace[];
  private readonly lasers: THREE.Line[];
  /** 各手が今つかんでいる対象 */
  private readonly heldTarget: GrabTarget[] = [null, null];
  /** 各手のレイが指しているパネル/ボタン(select/squeezeの分岐に使う) */
  private readonly rayHit: RayHit[] = [
    { panel: null, index: -1, distance: 0 },
    { panel: null, index: -1, distance: 0 },
  ];
  /** アバター片手つかみ: グリップ座標系でのroomSpaceのオフセット */
  private readonly grabOffset = new THREE.Matrix4();
  private grabHand = -1;
  /** パネルつかみ: 各手が掴んでいるパネルとグリップ座標系でのオフセット */
  private readonly grabbedPanel: (ArPanel | null)[] = [null, null];
  private readonly panelGrabOffset = [new THREE.Matrix4(), new THREE.Matrix4()];
  /** 両手つかみ開始時のスナップショット */
  private twoHand: {
    distance: number;
    scale: number;
    midpoint: THREE.Vector3;
    angle: number;
    rootPos: THREE.Vector3;
    rootQuat: THREE.Quaternion;
  } | null = null;

  private boundsBox: THREE.Object3D | null = null;
  /** このセッションでDOMオーバーレイが有効か(AR開始時に判定) */
  private domOverlayActive = false;
  /**
   * 設置済みか。設置後はレティクル(床のリング)を隠し、タップ/トリガーでの
   * 再設置も止める(見ているものの前で誤って動かないようにする)。
   * 置き直すときは requestPlacement() で設置モードへ戻す
   */
  private placed = false;
  /** 床が原点の参照空間(local-floor)を使えているか */
  private floorSpace = false;
  /** AR開始直後、最初のフレームで正面へ仮置きする */
  private initialPlacementPending = false;
  /** スマホAR(コントローラ無し端末)向けのタッチ操作 */
  private readonly touchAR: TouchAR;
  /** 実際に使った描画バッファ倍率(解像度の診断に出す) */
  private framebufferScale = 1;
  /** 実測から算出した、次回に使う倍率 */
  private suggestedScale = 1;
  /** AR前のキャンバスの大きさ(終了時に戻す) */
  private savedSize: { width: number; height: number } | null = null;
  private savedPixelRatio = 1;
  /** AR機能の探りボード(初回フレームで判定して表示) */
  private probePending = false;
  private probeBoard: THREE.Mesh | null = null;
  private probeLines: string[] = [];
  /** 深度の中身をボードへ足すのを待っているか(深度は開始から遅れて届く) */
  private depthProbePending = false;

  /**
   * 平面ベースのオクルージョン: plane-detectionで検出した現実の面
   * (壁・机の天板等)を「色を描かず深度だけ書くメッシュ」として描画し、
   * その裏に居るアバターを隠す。床は(アバターが上に立つため)除外する
   */
  private readonly planeOccluders = new Map<
    object,
    { mesh: THREE.Mesh; lastChanged: number; rebuiltAt: number; skip: boolean }
  >();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly roomSpace: THREE.Group,
    private readonly panels: ArPanel[],
    private readonly elements: ArElements,
    private readonly onModeChange: (arActive: boolean) => void,
  ) {
    this.lighting = new ArLighting(scene, (scale) => this.onDefaultLightScale?.(scale));
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.9, transparent: true }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    scene.add(this.reticle);
    for (const panel of panels) scene.add(panel.object);

    // コントローラ: grip(つかみ姿勢)と controller(ポインタ姿勢)は別物
    this.grips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
    this.controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
    const laserGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    this.lasers = [0, 1].map(() => {
      const laser = new THREE.Line(
        laserGeom,
        new THREE.LineBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.7 }),
      );
      laser.visible = false;
      return laser;
    });
    for (const i of [0, 1] as const) {
      this.scene.add(this.grips[i]!);
      this.controllers[i]!.add(this.lasers[i]!);
      this.controllers[i]!.addEventListener('squeezestart', () => this.onSqueezeStart(i));
      this.controllers[i]!.addEventListener('squeezeend', () => this.onSqueezeEnd(i));
      this.controllers[i]!.addEventListener('selectstart', () => this.onSelectStart(i));
      this.scene.add(this.controllers[i]!);
    }

    this.touchAR = new TouchAR({
      touchEl: elements.touch,
      renderer,
      roomSpace,
      panels,
      place: () => this.place(),
      onScaleChanged: (scale) => this.onScaleChanged?.(scale),
      setHint: (text) => (this.elements.hint.textContent = text),
    });

    void this.init();
  }

  private async init(): Promise<void> {
    const supported = await navigator.xr?.isSessionSupported('immersive-ar').catch(() => false);
    if (!supported) return;
    this.elements.button.hidden = false;
    this.elements.button.addEventListener('click', () => void this.start());
    this.elements.exitButton.addEventListener('click', () => void this.session?.end());
    // 終了ボタンのタップがXRのselect(=設置)として拾われないようにする
    this.elements.exitButton.addEventListener('beforexrselect', (event) => event.preventDefault());
  }

  private async start(): Promise<void> {
    if (this.session) return;
    try {
      // 注意: depth-sensing は既定では Quest でだけ要求する。Chrome(ARCore)では許可されると
      // three.js が自動で深度オクルージョン処理を始め、深度データが流れ始める
      // 瞬間(=床認識確立時)にフリーズする事例があった(depthOcclusion.ts)
      const depth = shouldRequestDepth();
      const session = await navigator.xr!.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        // local-floor は既定機能ではないため、ここで要求しないと
        // requestReferenceSpace('local-floor') が拒否される
        optionalFeatures: [
          'local-floor',
          'dom-overlay',
          'mesh-detection',
          'plane-detection',
          'anchors',
          // 部屋の明るさと光の向き(Chrome のみ。arLighting.ts)
          'light-estimation',
          // 現実の人や物でアバターを隠す(Quest 3 等。depthOcclusion.ts)
          ...(depth ? ['depth-sensing'] : []),
        ],
        ...(depth ? { depthSensing: DEPTH_SENSING_INIT } : {}),
        domOverlay: { root: this.elements.overlayRoot },
      } as XRSessionInit);
      this.probePending = true;
      this.session = session;
      this.lighting.start(session);
      this.onModeChange(true);
      this.elements.overlayRoot.hidden = false;
      this.elements.hint.textContent = '床にかざしてタップで設置 / 二本指で伸縮';
      this.touchAR.setEnabled(true);
      for (const laser of this.lasers) laser.visible = true;

      // DOMオーバーレイが効く端末(スマホ)は画面固定のボタンで操作できるので、
      // 空間パネルは出さない。HMDはDOMが見えないため空間パネルを使う
      const enabled = (session as unknown as { enabledFeatures?: readonly string[] })
        .enabledFeatures;
      this.domOverlayActive = enabled ? enabled.includes('dom-overlay') : false;
      this.onOverlayModeChange?.(this.domOverlayActive);
      if (!this.domOverlayActive) {
        // 各パネルを初期配置(視点=原点の前方)に、視点へ向けて出す
        for (const panel of this.panels) {
          _q1.setFromAxisAngle(new THREE.Vector3(0, 1, 0), panel.arPlacement.yaw);
          panel.show(panel.arPlacement.position.clone(), _q1);
        }
      }

      /**
       * 'local' は原点がセッション開始時の「頭の位置」になるため、原点に置いた
       * アバターは足元が目の高さに来てしまう(見上げる形になる)。
       * 'local-floor' なら原点が床なので、y=0 に置けば足が接地する
       */
      this.floorSpace = await session
        .requestReferenceSpace('local-floor')
        .then(() => true)
        .catch(() => false);
      this.renderer.xr.setReferenceSpaceType(this.floorSpace ? 'local-floor' : 'local');
      /**
       * 描画バッファの倍率。
       *
       * WebXRの既定(1.0)は端末の「推奨」解像度で、**画面の物理解像度より
       * かなり低いことが多い**。3Dだけがボケる原因はたいていこれ。
       * `getNativeFramebufferScaleFactor` が画面と等倍になる値を返すので、
       * それを使う(負荷が上がりすぎないよう上限は設ける)。
       *
       * **setSession の前に呼ぶ必要がある**(バッファはそこで作られるため)
       */
      const nativeScale =
        (
          XRWebGLLayer as unknown as {
            getNativeFramebufferScaleFactor?: (s: XRSession) => number;
          }
        ).getNativeFramebufferScaleFactor?.(session) ?? 1;
      this.framebufferScale = clampScale(Math.max(preferredFramebufferScale(), nativeScale));
      this.renderer.xr.setFramebufferScaleFactor(this.framebufferScale);
      /**
       * **キャンバスを画面いっぱい・フル解像度にしてからセッションを張る。**
       *
       * 一部の実装(iOSのARランチャー等)は、XRの描画バッファを
       * `framebufferScaleFactor` ではなく**キャンバスのCSSサイズ**から決める。
       * 視聴ページのステージは16:9の小さめの箱なので、そのまま入ると
       * 極端に低い解像度になる(実測 408x230 = 画面の0.31倍)。
       * ページを拡大したままARに入るとさらに荒くなるのも同じ理由
       */
      this.enterFullResolution();
      /**
       * **レイアウトの反映を待ってからセッションを張る。**
       * 上記のとおり描画バッファがキャンバスのCSSサイズから決まる実装があり、
       * 広げた直後にセッションを張ると**初回だけ**古い大きさが読まれる
       * (2回目以降は前回の状態が残っているため成立してしまい、
       * 「最初の一回だけボケる」という分かりにくい形で出る)
       */
      await nextLayoutFrame();
      await this.renderer.xr.setSession(session);
      this.tuneFramebufferScale(session);
      this.refSpace = this.renderer.xr.getReferenceSpace();
      console.log(`[ar] 参照空間: ${this.floorSpace ? 'local-floor(床が原点)' : 'local(頭が原点)'}`);
      /**
       * HMDは最初のフレームで正面へ仮置きする(掴んで引き寄せる手間をなくす)。
       *
       * **スマホでは仮置きしない。** 画面いっぱいに等身大のアバターが
       * いきなり現れると、どこに何が起きたのか分からず戸惑う。
       * 床をタップして自分で置いてもらうほうが、AR であることが伝わる
       */
      const phone = this.domOverlayActive;
      this.initialPlacementPending = !phone;
      if (phone) {
        this.placed = false;
        this.setAvatarVisible(false);
        this.elements.hint.textContent = '床にカメラを向けて、丸が出たらタップして置いてください';
      }

      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
      if (!this.hitTestSource) {
        /**
         * 床検知が無いと「タップして置く」ができない。
         * スマホで隠したままにすると**永久にアバターが出てこない**ので、
         * 正面への仮置きへ切り替える
         */
        this.initialPlacementPending = true;
        this.setAvatarVisible(true);
        this.elements.hint.textContent =
          'この端末は床検知に未対応です(正面に置きます)';
      }

      session.addEventListener('end', () => this.cleanup());
    } catch (error) {
      console.error('[ar] セッション開始に失敗:', error);
      this.cleanup();
    }
  }

  /** アバターのローカルバウンディングボックス(つかみ時の可視化)を作り直す */
  setAvatarBounds(localBounds: THREE.Box3): void {
    if (this.boundsBox) {
      this.roomSpace.remove(this.boundsBox);
      this.boundsBox = null;
    }
    const size = localBounds.getSize(new THREE.Vector3()).addScalar(0.08);
    const center = localBounds.getCenter(new THREE.Vector3());
    const group = new THREE.Group();
    const geometry = new THREE.BoxGeometry(size.x, size.y, size.z);
    const fill = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({
        color: 0x88ccff,
        transparent: true,
        opacity: 0.12,
        depthWrite: false,
        side: THREE.DoubleSide,
      }),
    );
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry),
      new THREE.LineBasicMaterial({ color: 0xaaddff, transparent: true, opacity: 0.6 }),
    );
    group.add(fill, edges);
    group.position.copy(center);
    group.visible = false;
    this.boundsBox = group;
    this.roomSpace.add(group);
  }

  /** 実際に許可されたAR機能を初回フレームで判定し、空間内ボードとコンソールへ出す */
  private probeFeatures(frame: XRFrame): void {
    this.probePending = false;
    const session = this.session!;
    const enabled = (session as unknown as { enabledFeatures?: string[] }).enabledFeatures;
    const has = (feature: string, fallback: boolean): string => {
      const granted = enabled ? enabled.includes(feature) : fallback;
      return granted ? '✅' : '❌';
    };
    const lines = [
      'AR機能の対応状況:',
      `mesh-detection: ${has('mesh-detection', 'detectedMeshes' in frame)}`,
      `plane-detection: ${has('plane-detection', 'detectedPlanes' in frame)}`,
      `anchors: ${has('anchors', 'createAnchor' in frame)}`,
      `light-estimation: ${has('light-estimation', false)}`,
      `depth-sensing: ${depthDescription(session) ?? '❌'}`,
      `dom-overlay: ${has('dom-overlay', false)}`,
    ];
    console.log('[ar probe]', lines.join(' / '), 'enabledFeatures=', enabled);
    this.probeLines = lines;
    this.depthProbePending = depthDescription(session) !== null;

    const canvas = document.createElement('canvas');
    canvas.width = 800;
    canvas.height = 560;
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.56),
      new THREE.MeshBasicMaterial({
        map: new THREE.CanvasTexture(canvas),
        transparent: true,
        // 深度オクルージョンが誤って全部を隠すときでも読めるよう、深度を見ずに最前面へ出す
        depthTest: false,
      }),
    );
    board.renderOrder = 10;
    board.position.set(0, 1.5, -1.2); // 開始時の正面・目の高さ
    this.probeBoard = board;
    this.drawProbeBoard();
    this.scene.add(board);
    window.setTimeout(() => this.removeProbeBoard(), 20000);
  }

  private drawProbeBoard(): void {
    const material = this.probeBoard?.material as THREE.MeshBasicMaterial | undefined;
    const texture = material?.map as THREE.CanvasTexture | undefined;
    const canvas = texture?.image as HTMLCanvasElement | undefined;
    if (!texture || !canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '26px sans-serif';
    this.probeLines.forEach((line, i) => ctx.fillText(line, 20, 42 + i * 40));
    texture.needsUpdate = true;
  }

  /** 深度が届いたら、その中身の手がかりをボードへ足す */
  private probeDepth(frame: XRFrame): void {
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (!refSpace) return;
    const lines = depthInfoLines(this.renderer, frame, refSpace);
    if (!lines) return;
    this.depthProbePending = false;
    console.log('[ar probe]', lines.join(' / '));
    this.probeLines = [...this.probeLines, ...lines];
    this.drawProbeBoard();
  }

  private removeProbeBoard(): void {
    if (this.probeBoard) {
      this.scene.remove(this.probeBoard);
      this.probeBoard = null;
    }
  }

  private frameErrorShown = false;

  /** 毎フレーム呼ぶ。レティクル更新・ヒットキャッシュ・つかみ追従。
   *  例外はここで握りつぶす(投げると描画ループごと止まり画面が固まる) */
  onFrame(frame: XRFrame | undefined): void {
    try {
      this.onFrameInner(frame);
    } catch (error) {
      console.error('[ar] フレーム処理でエラー:', error);
      if (!this.frameErrorShown) {
        this.frameErrorShown = true;
        this.elements.hint.textContent = `ARエラー: ${String(error).slice(0, 120)}`;
      }
    }
  }

  private onFrameInner(frame: XRFrame | undefined): void {
    if (!frame || !this.session) return;
    if (this.probePending) this.probeFeatures(frame);
    if (this.depthProbePending && this.probeBoard) this.probeDepth(frame);
    this.lighting.update(frame);
    updateDepthOcclusion(this.renderer);

    // 視点の姿勢はヒットテストの有無に関わらず要る(初期配置・設置時の向き)
    const viewer = this.refSpace ? frame.getViewerPose(this.refSpace) : null;
    if (viewer) {
      this.latestViewer.set(
        viewer.transform.position.x,
        viewer.transform.position.y,
        viewer.transform.position.z,
      );
    }

    if (this.hitTestSource && this.refSpace) {
      const hit = frame.getHitTestResults(this.hitTestSource)[0];
      const pose = hit?.getPose(this.refSpace);
      if (pose) {
        this.reticle.visible = !this.placed && this.avatarHands() === 0;
        this.reticle.matrix.fromArray(pose.transform.matrix);
        this.latestHit = (this.latestHit ?? new THREE.Vector3()).set(
          pose.transform.position.x,
          pose.transform.position.y,
          pose.transform.position.z,
        );
      } else {
        this.reticle.visible = false;
        this.latestHit = null;
      }
    }

    // 初期配置。床の高さは local-floor なら 0、そうでなければヒットテストの
    // 検出結果を待つ('local' は原点が頭の高さなので、そのままでは足が浮く)
    if (this.initialPlacementPending && viewer) {
      const floorY = this.floorSpace ? 0 : this.latestHit?.y;
      if (floorY !== undefined) {
        this.initialPlacementPending = false;
        this.placeInFront(viewer, floorY);
      }
    }

    this.updatePlaneOccluders(frame);
    this.updateRays();
    this.updateGrab();
  }

  /** 各コントローラのレイを全パネルに当て、最も近い交差でホバー+レーザー長を更新 */
  private updateRays(): void {
    // パネルごとのホバーindex(-1=なし)。両手ぶんを集計してから一括反映する
    const hover = new Map<ArPanel, number>();
    for (const i of [0, 1] as const) {
      const controller = this.controllers[i]!;
      const laser = this.lasers[i]!;
      _m1.identity().extractRotation(controller.matrixWorld);
      _raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      _raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_m1);

      let best: RayHit = { panel: null, index: -1, distance: Infinity };
      for (const panel of this.panels) {
        const hit = panel.raycast(_raycaster);
        if (hit && hit.distance < best.distance) {
          best = { panel, index: hit.index, distance: hit.distance };
        }
      }
      this.rayHit[i] = best.panel ? best : { panel: null, index: -1, distance: 0 };
      laser.scale.z = best.panel ? best.distance : LASER_DEFAULT_LEN;
      if (best.panel && best.index >= 0) hover.set(best.panel, best.index);
    }
    for (const panel of this.panels) panel.setHover(hover.get(panel) ?? -1);
  }

  private updatePlaneOccluders(frame: XRFrame): void {
    interface PlaneLike {
      planeSpace: XRSpace;
      polygon: { x: number; z: number }[];
      orientation?: string;
      lastChangedTime: number;
    }
    const detected = (frame as unknown as { detectedPlanes?: Set<PlaneLike> }).detectedPlanes;
    const refSpace = this.renderer.xr.getReferenceSpace();
    if (!detected || !refSpace) return;

    // 消えた平面のオクルーダーを破棄
    for (const [plane, entry] of this.planeOccluders) {
      if (!detected.has(plane as PlaneLike)) {
        this.disposeOccluder(entry.mesh);
        this.planeOccluders.delete(plane);
      }
    }

    const now = performance.now();
    for (const plane of detected) {
      let entry = this.planeOccluders.get(plane);
      // ARCoreはスキャン中ポリゴンを毎フレーム更新し続けるため、
      // ジオメトリ再構築は0.5秒に1回までに間引く(毎フレーム再構築すると重い)
      const needsRebuild =
        !entry || (entry.lastChanged < plane.lastChangedTime && now - entry.rebuiltAt > 500);
      if (needsRebuild) {
        if (entry) this.disposeOccluder(entry.mesh);
        const mesh = this.buildOccluderMesh(plane.polygon);
        entry = { mesh, lastChanged: plane.lastChangedTime, rebuiltAt: now, skip: false };
        this.planeOccluders.set(plane, entry);
        this.scene.add(mesh);
      }
      if (!entry) continue;
      if (entry.skip) continue;
      const pose = frame.getPose(plane.planeSpace, refSpace);
      if (!pose) {
        entry.mesh.visible = false;
        continue;
      }
      entry.mesh.matrix.fromArray(pose.transform.matrix);
      // 床(低い位置の水平面)はアバターが上に立つため除外(足がちらつく)
      if (plane.orientation?.toLowerCase() === 'horizontal' && pose.transform.position.y < 0.3) {
        entry.skip = true;
        entry.mesh.visible = false;
        continue;
      }
      entry.mesh.visible = true;
    }
  }

  private buildOccluderMesh(polygon: { x: number; z: number }[]): THREE.Mesh {
    const shape = new THREE.Shape();
    polygon.forEach((p, i) => (i === 0 ? shape.moveTo(p.x, p.z) : shape.lineTo(p.x, p.z)));
    const geometry = new THREE.ShapeGeometry(shape);
    geometry.rotateX(Math.PI / 2); // (x, y)平面 → 平面ローカルの(x, z)平面へ
    const mesh = new THREE.Mesh(
      geometry,
      new THREE.MeshBasicMaterial({ colorWrite: false }), // 深度のみ書き込む
    );
    mesh.renderOrder = -1; // アバターより先に描いて深度を確定させる
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    return mesh;
  }

  private disposeOccluder(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.Material).dispose();
  }

  private avatarHands(): number {
    return (this.heldTarget[0] === 'avatar' ? 1 : 0) + (this.heldTarget[1] === 'avatar' ? 1 : 0);
  }

  /** トリガー: パネルのボタン上なら選択、そうでなければアバターを設置 */
  private onSelectStart(index: number): void {
    if (!this.session) return;
    const hit = this.rayHit[index];
    if (hit.panel) {
      if (hit.index >= 0) hit.panel.activate(hit.index);
      return; // パネル操作はアバター設置に波及させない
    }
    this.place();
  }

  private onSqueezeStart(index: number): void {
    if (!this.session) return;

    // パネルを指しながらグリップ → そのパネルをつかむ
    const hit = this.rayHit[index];
    if (hit.panel) {
      this.heldTarget[index] = 'panel';
      this.grabbedPanel[index] = hit.panel;
      const grip = this.grips[index]!;
      grip.updateWorldMatrix(true, false);
      hit.panel.object.updateWorldMatrix(true, false);
      this.panelGrabOffset[index]!.copy(grip.matrixWorld).invert().multiply(hit.panel.object.matrixWorld);
      this.elements.hint.textContent = 'パネルを移動';
      return;
    }

    // それ以外 → アバターをつかむ
    this.heldTarget[index] = 'avatar';
    if (this.boundsBox) this.boundsBox.visible = true;
    if (this.avatarHands() === 2) {
      const a = this.grips[0]!.getWorldPosition(_v1);
      const b = this.grips[1]!.getWorldPosition(_v2);
      this.twoHand = {
        distance: Math.max(a.distanceTo(b), 0.01),
        scale: this.roomSpace.scale.x,
        midpoint: a.clone().add(b).multiplyScalar(0.5),
        angle: Math.atan2(b.x - a.x, b.z - a.z),
        rootPos: this.roomSpace.position.clone(),
        rootQuat: this.roomSpace.quaternion.clone(),
      };
      this.elements.hint.textContent = '両手で伸縮・回転';
    } else {
      this.beginOneHandGrab(index);
      this.elements.hint.textContent = 'つかんで移動(もう片方のグリップで伸縮)';
    }
  }

  private onSqueezeEnd(index: number): void {
    const was = this.heldTarget[index];
    this.heldTarget[index] = null;
    if (was === 'panel') {
      this.grabbedPanel[index] = null;
      return;
    }
    // アバター側
    this.twoHand = null;
    if (this.avatarHands() === 0) {
      this.grabHand = -1;
      if (this.boundsBox) this.boundsBox.visible = false;
      // つかんで置いた時点で配置済みとみなす(レティクルを出しっぱなしにしない)
      this.placed = true;
      this.elements.hint.textContent = 'つかんで移動しました';
    } else {
      // 片手が残ったらその手でつかみ直す
      this.beginOneHandGrab(this.heldTarget[0] === 'avatar' ? 0 : 1);
    }
  }

  private beginOneHandGrab(index: number): void {
    const grip = this.grips[index]!;
    grip.updateWorldMatrix(true, false);
    this.roomSpace.updateWorldMatrix(true, false);
    this.grabOffset.copy(grip.matrixWorld).invert().multiply(this.roomSpace.matrixWorld);
    this.grabHand = index;
  }

  private updateGrab(): void {
    // パネルつかみ(片手・スケールなし)。各手が別々のパネルを掴める
    for (const i of [0, 1] as const) {
      const panel = this.grabbedPanel[i];
      if (panel && this.heldTarget[i] === 'panel') {
        _m1.multiplyMatrices(this.grips[i]!.matrixWorld, this.panelGrabOffset[i]!);
        _m1.decompose(panel.object.position, panel.object.quaternion, _v1);
      }
    }

    // アバター両手つかみ(伸縮+回転)
    if (this.twoHand && this.avatarHands() === 2) {
      const snap = this.twoHand;
      const a = this.grips[0]!.getWorldPosition(_v1);
      const b = this.grips[1]!.getWorldPosition(_v2);
      const distance = Math.max(a.distanceTo(b), 0.01);
      const scale = THREE.MathUtils.clamp(
        snap.scale * (distance / snap.distance),
        SCALE_MIN,
        SCALE_MAX,
      );
      const ratio = scale / snap.scale;
      const angle = Math.atan2(b.x - a.x, b.z - a.z);
      _q1.setFromAxisAngle(new THREE.Vector3(0, 1, 0), angle - snap.angle);

      const midpoint = a.add(b).multiplyScalar(0.5); // _v1を流用
      this.roomSpace.scale.setScalar(scale);
      this.onScaleChanged?.(scale);
      this.roomSpace.quaternion.copy(_q1).multiply(snap.rootQuat);
      this.roomSpace.position
        .copy(snap.rootPos)
        .sub(snap.midpoint)
        .multiplyScalar(ratio)
        .applyQuaternion(_q1)
        .add(midpoint);
    } else if (this.grabHand >= 0 && this.heldTarget[this.grabHand] === 'avatar') {
      // アバター片手つかみ
      const grip = this.grips[this.grabHand]!;
      _m1.multiplyMatrices(grip.matrixWorld, this.grabOffset);
      _m1.decompose(this.roomSpace.position, this.roomSpace.quaternion, _v1);
    }
  }

  /** レティクル位置に設置(スケール維持・直立・視聴者の方を向く) */
  /**
   * AR開始直後に、視線の前方へ足を接地させて仮置きする。
   * 'local' では床の高さが分からないため、local-floor が使えるときだけ呼ぶ。
   * これが無いと原点(=頭の高さ・自分と同じ場所)に立つので、見上げたうえで
   * 掴んで引き寄せる必要があった
   */
  private placeInFront(viewer: XRViewerPose, floorY: number): void {
    const p = viewer.transform.position;
    const o = viewer.transform.orientation;
    _q1.set(o.x, o.y, o.z, o.w);
    // 視線の水平成分(真上や真下を向いていた場合の保険つき)
    _v1.set(0, 0, -1).applyQuaternion(_q1);
    _v1.y = 0;
    if (_v1.lengthSq() < 1e-6) _v1.set(0, 0, -1);
    _v1.normalize();

    const x = p.x + _v1.x * INITIAL_PLACE_DISTANCE;
    const z = p.z + _v1.z * INITIAL_PLACE_DISTANCE;
    this.roomSpace.position.set(x, floorY, z);
    this.roomSpace.quaternion.setFromAxisAngle(UP_AXIS, Math.atan2(p.x - x, p.z - z));
    this.placed = true;
    this.reticle.visible = false;
    this.elements.hint.textContent = '正面に置きました(設定の「置き直す」で移動できます)';
  }

  private place(): void {
    // 設置済みのあいだは無視する(画面のどこを触ってもアバターが飛ぶのを防ぐ)
    if (!this.session || this.placed || this.avatarHands() > 0 || !this.latestHit) return;
    const p = this.latestHit;
    const yaw = Math.atan2(this.latestViewer.x - p.x, this.latestViewer.z - p.z);
    this.roomSpace.position.copy(p);
    this.roomSpace.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.placed = true;
    this.reticle.visible = false;
    this.setAvatarVisible(true);
    this.elements.hint.textContent = '設置しました(ドラッグで移動・ピンチで拡大縮小)';
  }

  /**
   * 設置前にアバターを隠す。
   * スマホでは「置く」操作を挟むので、置くまでは見せない
   */
  private setAvatarVisible(visible: boolean): void {
    this.roomSpace.visible = visible;
  }

  /**
   * キャンバスを画面いっぱい・端末のフル解像度にする。
   * AR中はカメラ映像の上に描くので、ページ内のレイアウトは関係なくなる
   */
  private enterFullResolution(): void {
    this.savedPixelRatio = this.renderer.getPixelRatio();
    const size = this.renderer.getSize(new THREE.Vector2());
    this.savedSize = { width: size.x, height: size.y };
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setSize(window.innerWidth, window.innerHeight, true);
    // 大きさを読んでレイアウトを同期的に確定させる(反映前に読まれるのを防ぐ)
    void this.renderer.domElement.offsetWidth;
  }

  /** AR前のキャンバスの大きさに戻す */
  private exitFullResolution(): void {
    if (!this.savedSize) return;
    this.renderer.setPixelRatio(this.savedPixelRatio);
    this.renderer.setSize(this.savedSize.width, this.savedSize.height, true);
    this.savedSize = null;
  }

  /**
   * 実際に得られた解像度を測り、次回のセッションで使う倍率を決める。
   *
   * **倍率はセッション開始時にしか変えられない**(バッファがそこで作られる)。
   * 端末が返す「推奨」解像度は環境によって画面の1/3ほどしかないことがあり、
   * その値は事前には分からない。そこで実測して次回へ持ち越す
   */
  private tuneFramebufferScale(session: XRSession): void {
    const layer = session.renderState.baseLayer;
    if (!layer) return;
    const screenWidth = window.innerWidth * window.devicePixelRatio;
    const ratio = layer.framebufferWidth / Math.max(1, screenWidth);
    if (!Number.isFinite(ratio) || ratio <= 0) return;
    // 画面と等倍(ratio=1)になる倍率へ寄せる
    this.suggestedScale = clampScale(this.framebufferScale / ratio);
    if (Math.abs(this.suggestedScale - this.framebufferScale) < 0.1) return;
    try {
      localStorage.setItem(SCALE_STORAGE_KEY, String(this.suggestedScale));
    } catch {
      // 保存できない環境では毎回初期値のまま(実害はない)
    }
  }

  /**
   * 解像度の診断。**ボケの原因が「描画バッファが小さい」のか
   * 「アプリ側が画面ごと縮小している」のかを切り分ける**ために、
   * 実測値をそのまま出す(コンソールを見られない端末で確認するため)。
   *
   * 3D と画面の比が 1 に近ければ、こちら側で詰められる余地は無い
   */
  get resolutionReport(): string {
    const layer = this.session?.renderState.baseLayer;
    if (!layer) return 'AR中ではありません';
    const screenW = Math.round(window.innerWidth * window.devicePixelRatio);
    const screenH = Math.round(window.innerHeight * window.devicePixelRatio);
    const ratio = (layer.framebufferWidth / Math.max(1, screenW)).toFixed(2);
    const canvas = this.renderer.domElement;
    return [
      `3D描画 ${layer.framebufferWidth}x${layer.framebufferHeight}`,
      `画面 ${screenW}x${screenH}(dpr ${window.devicePixelRatio})`,
      // キャンバスと3Dの大きさが一致するなら、倍率指定は効いていない
      `キャンバス CSS ${canvas.clientWidth}x${canvas.clientHeight} / 実 ${canvas.width}x${canvas.height}`,
      `比 ${ratio} / 倍率 ${this.framebufferScale.toFixed(2)}`,
    ].join(' / ');
  }

  /** AR中のヒント表示を差し替える(AR外では何もしない) */
  showHint(text: string): void {
    if (!this.session) return;
    this.elements.hint.textContent = text;
  }

  get isPresenting(): boolean {
    return this.session !== null;
  }

  /**
   * 視聴者の気配で使う端末種別。
   * DOMオーバーレイが効くのはスマホ(HMDのブラウザでは表示されない)なので、
   * AR中はその可否で分ける
   */
  get deviceKind(): 'hmd' | 'phone' | 'desktop' {
    if (!this.session) return 'desktop';
    return this.domOverlayActive ? 'phone' : 'hmd';
  }

  /** コントローラのグリップ姿勢(AR中のみ。掴んでいる手も含めてそのまま返す) */
  getGrip(index: 0 | 1): THREE.Object3D | null {
    const grip = this.grips[index];
    // 未接続のコントローラは原点に置かれたままなので、見えているものだけ返す
    return this.session && grip && grip.visible ? grip : null;
  }

  /** 設置モードへ戻す(レティクルを再表示し、次のタップ/トリガーで置き直す) */
  requestPlacement(): void {
    if (!this.session) return;
    this.placed = false;
    // スマホは置くまで隠す(初回と同じ流れにする)。HMDは掴んで動かせるので出したまま
    if (this.domOverlayActive) this.setAvatarVisible(false);
    this.elements.hint.textContent = '床にかざして、タップ/トリガーで置き直し';
  }

  private cleanup(): void {
    this.removeProbeBoard();
    this.lighting.stop();
    this.probePending = false;
    this.depthProbePending = false;
    this.frameErrorShown = false;
    this.exitFullResolution();
    this.touchAR.setEnabled(false);
    for (const entry of this.planeOccluders.values()) this.disposeOccluder(entry.mesh);
    this.planeOccluders.clear();
    this.session = null;
    this.hitTestSource = null;
    this.refSpace = null;
    this.latestHit = null;
    this.placed = false;
    this.floorSpace = false;
    this.initialPlacementPending = false;
    this.reticle.visible = false;
    // AR中に隠していた場合があるので、通常表示へ必ず戻す
    this.setAvatarVisible(true);
    this.heldTarget[0] = null;
    this.heldTarget[1] = null;
    this.twoHand = null;
    this.grabHand = -1;
    this.grabbedPanel[0] = null;
    this.grabbedPanel[1] = null;
    if (this.boundsBox) this.boundsBox.visible = false;
    for (const panel of this.panels) panel.hide();
    for (const laser of this.lasers) laser.visible = false;
    // 通常表示に戻るときは配置をリセット(デスクトップ表示は原点前提)
    this.roomSpace.position.set(0, 0, 0);
    this.roomSpace.quaternion.identity();
    this.roomSpace.scale.setScalar(1);
    this.onScaleChanged?.(1);
    this.elements.overlayRoot.hidden = true;
    this.onModeChange(false);
  }
}
