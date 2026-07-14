/**
 * WebXRパススルーAR(immersive-ar)。
 * - 対応端末(Androidスマホ/Quest/PICO等)でのみボタンを表示する
 * - ヒットテストで床にレティクルを出し、トリガー(select)で設置
 * - グリップ(squeeze)でアバターをつかんで移動、両手グリップで伸縮+回転(卓上モード)
 * - 設置・つかみ・スケールはすべて avatarRoot(配置フレーム)の変換として行う。
 *   PoseApplierがフレーム対応なので、IK・足接地・ルートモーションは壊れない
 *
 * 互換性メモ: 一部ブラウザ(PICO等)はselectイベントのXRFrameでヒットテスト
 * 結果を返さないため、rAFフレームで結果をキャッシュして設置時に使う。
 */
import * as THREE from 'three';

export interface ArElements {
  button: HTMLButtonElement;
  overlayRoot: HTMLElement;
  hint: HTMLElement;
  exitButton: HTMLButtonElement;
}

const SCALE_MIN = 0.1;
const SCALE_MAX = 2.5;

const _m1 = new THREE.Matrix4();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q1 = new THREE.Quaternion();

export class ArController {
  /** スケールが変わったときに呼ばれる(スプリングボーン等の追従用) */
  onScaleChanged: ((scale: number) => void) | null = null;

  private session: XRSession | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private refSpace: XRReferenceSpace | null = null;
  private readonly reticle: THREE.Mesh;

  /** rAFフレームでキャッシュした床ヒット位置と視点位置(select時に使用) */
  private latestHit: THREE.Vector3 | null = null;
  private readonly latestViewer = new THREE.Vector3();

  // ---- つかみ状態 ----
  private readonly grips: THREE.Object3D[];
  private readonly held = [false, false];
  /** 片手つかみ: グリップ座標系でのavatarRootのオフセット */
  private readonly grabOffset = new THREE.Matrix4();
  private grabHand = -1;
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
  /** AR機能の探りボード(初回フレームで判定して表示) */
  private probePending = false;
  private probeBoard: THREE.Mesh | null = null;

  /**
   * 平面ベースのオクルージョン: plane-detectionで検出した現実の面
   * (壁・机の天板等)を「色を描かず深度だけ書くメッシュ」として描画し、
   * その裏に居るアバターを隠す。床は(アバターが上に立つため)除外する
   */
  private readonly planeOccluders = new Map<
    object,
    { mesh: THREE.Mesh; lastChanged: number; skip: boolean }
  >();

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly scene: THREE.Scene,
    private readonly avatarRoot: THREE.Group,
    private readonly elements: ArElements,
    private readonly onModeChange: (arActive: boolean) => void,
  ) {
    this.reticle = new THREE.Mesh(
      new THREE.RingGeometry(0.12, 0.16, 32).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, opacity: 0.9, transparent: true }),
    );
    this.reticle.matrixAutoUpdate = false;
    this.reticle.visible = false;
    scene.add(this.reticle);

    // コントローラ(グリップ姿勢)。シーンに入れておくとthree.jsが毎フレーム更新する
    this.grips = [renderer.xr.getControllerGrip(0), renderer.xr.getControllerGrip(1)];
    for (const grip of this.grips) scene.add(grip);
    for (const i of [0, 1] as const) {
      const controller = renderer.xr.getController(i);
      controller.addEventListener('squeezestart', () => this.onSqueezeStart(i));
      controller.addEventListener('squeezeend', () => this.onSqueezeEnd(i));
      controller.addEventListener('selectstart', () => this.place());
      scene.add(controller);
    }

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
      const session = await navigator.xr!.requestSession('immersive-ar', {
        requiredFeatures: ['hit-test'],
        // depth-sensing等は「あれば使う」で要求し、実際に許可されたかを探る
        optionalFeatures: ['dom-overlay', 'depth-sensing', 'mesh-detection', 'plane-detection', 'anchors'],
        domOverlay: { root: this.elements.overlayRoot },
        depthSensing: {
          usagePreference: ['gpu-optimized', 'cpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32'],
        },
      } as XRSessionInit);
      this.probePending = true;
      this.session = session;
      this.onModeChange(true);
      this.elements.overlayRoot.hidden = false;
      this.elements.hint.textContent = '床にかざしてトリガーで設置 / グリップでつかむ';

      this.renderer.xr.setReferenceSpaceType('local');
      await this.renderer.xr.setSession(session);
      this.refSpace = this.renderer.xr.getReferenceSpace();

      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
      if (!this.hitTestSource) {
        this.elements.hint.textContent = 'この端末はヒットテスト(床検知)に未対応です';
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
      this.avatarRoot.remove(this.boundsBox);
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
    this.avatarRoot.add(group);
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
    let depthByApi = false;
    try {
      depthByApi = (session as unknown as { depthUsage?: string }).depthUsage !== undefined;
    } catch {
      depthByApi = false;
    }
    const lines = [
      'AR機能の対応状況:',
      `depth-sensing(オクルージョン): ${has('depth-sensing', depthByApi)}`,
      `mesh-detection: ${has('mesh-detection', 'detectedMeshes' in frame)}`,
      `plane-detection: ${has('plane-detection', 'detectedPlanes' in frame)}`,
      `anchors: ${has('anchors', 'createAnchor' in frame)}`,
      `dom-overlay: ${has('dom-overlay', false)}`,
    ];
    console.log('[ar probe]', lines.join(' / '), 'enabledFeatures=', enabled);

    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 320;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.font = '30px sans-serif';
    lines.forEach((line, i) => ctx.fillText(line, 24, 52 + i * 44));
    const board = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.4),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(canvas), transparent: true }),
    );
    board.position.set(0, 1.5, -1.2); // 開始時の正面・目の高さ
    this.probeBoard = board;
    this.scene.add(board);
    window.setTimeout(() => this.removeProbeBoard(), 20000);
  }

  private removeProbeBoard(): void {
    if (this.probeBoard) {
      this.scene.remove(this.probeBoard);
      this.probeBoard = null;
    }
  }

  /** 毎フレーム呼ぶ。レティクル更新・ヒットキャッシュ・つかみ追従 */
  onFrame(frame: XRFrame | undefined): void {
    if (!frame || !this.session) return;
    if (this.probePending) this.probeFeatures(frame);

    if (this.hitTestSource && this.refSpace) {
      const hit = frame.getHitTestResults(this.hitTestSource)[0];
      const pose = hit?.getPose(this.refSpace);
      if (pose) {
        this.reticle.visible = !this.isHolding();
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
      const viewer = frame.getViewerPose(this.refSpace);
      if (viewer) {
        this.latestViewer.set(
          viewer.transform.position.x,
          viewer.transform.position.y,
          viewer.transform.position.z,
        );
      }
    }

    this.updatePlaneOccluders(frame);
    this.updateGrab();
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

    for (const plane of detected) {
      let entry = this.planeOccluders.get(plane);
      if (!entry || entry.lastChanged < plane.lastChangedTime) {
        if (entry) this.disposeOccluder(entry.mesh);
        const mesh = this.buildOccluderMesh(plane.polygon);
        entry = { mesh, lastChanged: plane.lastChangedTime, skip: false };
        this.planeOccluders.set(plane, entry);
        this.scene.add(mesh);
      }
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

  private isHolding(): boolean {
    return this.held[0] || this.held[1];
  }

  private onSqueezeStart(index: number): void {
    if (!this.session) return;
    this.held[index] = true;
    if (this.boundsBox) this.boundsBox.visible = true;

    if (this.held[0] && this.held[1]) {
      // 両手: 伸縮+回転モードへ
      const a = this.grips[0]!.getWorldPosition(_v1);
      const b = this.grips[1]!.getWorldPosition(_v2);
      this.twoHand = {
        distance: Math.max(a.distanceTo(b), 0.01),
        scale: this.avatarRoot.scale.x,
        midpoint: a.clone().add(b).multiplyScalar(0.5),
        angle: Math.atan2(b.x - a.x, b.z - a.z),
        rootPos: this.avatarRoot.position.clone(),
        rootQuat: this.avatarRoot.quaternion.clone(),
      };
      this.elements.hint.textContent = '両手で伸縮・回転';
    } else {
      this.beginOneHandGrab(index);
      this.elements.hint.textContent = 'つかんで移動(もう片方のグリップで伸縮)';
    }
  }

  private onSqueezeEnd(index: number): void {
    this.held[index] = false;
    this.twoHand = null;
    if (!this.isHolding()) {
      this.grabHand = -1;
      if (this.boundsBox) this.boundsBox.visible = false;
      this.elements.hint.textContent = '設置しました(トリガーで置き直し)';
    } else {
      // 片手が残った場合はその手でつかみ直す
      this.beginOneHandGrab(this.held[0] ? 0 : 1);
    }
  }

  private beginOneHandGrab(index: number): void {
    const grip = this.grips[index]!;
    grip.updateWorldMatrix(true, false);
    this.avatarRoot.updateWorldMatrix(true, false);
    this.grabOffset.copy(grip.matrixWorld).invert().multiply(this.avatarRoot.matrixWorld);
    this.grabHand = index;
  }

  private updateGrab(): void {
    if (this.twoHand && this.held[0] && this.held[1]) {
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
      this.avatarRoot.scale.setScalar(scale);
      this.onScaleChanged?.(scale);
      this.avatarRoot.quaternion.copy(_q1).multiply(snap.rootQuat);
      this.avatarRoot.position
        .copy(snap.rootPos)
        .sub(snap.midpoint)
        .multiplyScalar(ratio)
        .applyQuaternion(_q1)
        .add(midpoint);
    } else if (this.grabHand >= 0 && this.held[this.grabHand]) {
      const grip = this.grips[this.grabHand]!;
      _m1.multiplyMatrices(grip.matrixWorld, this.grabOffset);
      _m1.decompose(this.avatarRoot.position, this.avatarRoot.quaternion, _v1);
      // スケールはつかみでは変えない(数値誤差の蓄積も防ぐ)
    }
  }

  /** トリガー: レティクル位置に設置(スケール維持・直立・視聴者の方を向く) */
  private place(): void {
    if (!this.session || this.isHolding() || !this.latestHit) return;
    const p = this.latestHit;
    const yaw = Math.atan2(this.latestViewer.x - p.x, this.latestViewer.z - p.z);
    this.avatarRoot.position.copy(p);
    this.avatarRoot.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
    this.elements.hint.textContent = '設置しました(グリップでつかめます)';
  }

  private cleanup(): void {
    this.removeProbeBoard();
    this.probePending = false;
    for (const entry of this.planeOccluders.values()) this.disposeOccluder(entry.mesh);
    this.planeOccluders.clear();
    this.session = null;
    this.hitTestSource = null;
    this.refSpace = null;
    this.latestHit = null;
    this.reticle.visible = false;
    this.held[0] = false;
    this.held[1] = false;
    this.twoHand = null;
    this.grabHand = -1;
    if (this.boundsBox) this.boundsBox.visible = false;
    // 通常表示に戻るときは配置をリセット(デスクトップ表示は原点前提)
    this.avatarRoot.position.set(0, 0, 0);
    this.avatarRoot.quaternion.identity();
    this.avatarRoot.scale.setScalar(1);
    this.onScaleChanged?.(1);
    this.elements.overlayRoot.hidden = true;
    this.onModeChange(false);
  }
}
