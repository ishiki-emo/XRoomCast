/**
 * WebXRパススルーAR(immersive-ar)。
 * - 対応端末(Androidスマホ/Quest等)でのみボタンを表示する
 * - ヒットテストで床にレティクルを出し、タップした位置にアバターを設置する
 * - 設置はアバターを動かすのではなく**XR基準空間をオフセット**する方式。
 *   シーン原点が設置点に来るので、IK・足接地・ルートモーションの
 *   座標系(ワールド=アバタールート前提)が一切壊れない
 */
import * as THREE from 'three';

export interface ArElements {
  button: HTMLButtonElement;
  overlayRoot: HTMLElement;
  hint: HTMLElement;
  exitButton: HTMLButtonElement;
}

export class ArController {
  private session: XRSession | null = null;
  private hitTestSource: XRHitTestSource | null = null;
  private baseRefSpace: XRReferenceSpace | null = null;
  private readonly reticle: THREE.Mesh;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
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
        optionalFeatures: ['dom-overlay'],
        domOverlay: { root: this.elements.overlayRoot },
      });
      this.session = session;
      this.onModeChange(true);
      this.elements.overlayRoot.hidden = false;
      this.elements.hint.textContent = '床にかざして、タップで設置';

      this.renderer.xr.setReferenceSpaceType('local');
      await this.renderer.xr.setSession(session);
      this.baseRefSpace = this.renderer.xr.getReferenceSpace();

      const viewerSpace = await session.requestReferenceSpace('viewer');
      this.hitTestSource = (await session.requestHitTestSource?.({ space: viewerSpace })) ?? null;
      if (!this.hitTestSource) {
        this.elements.hint.textContent = 'この端末はヒットテスト(床検知)に未対応です';
      }

      session.addEventListener('select', (event) => this.place(event));
      session.addEventListener('end', () => this.cleanup());
    } catch (error) {
      console.error('[ar] セッション開始に失敗:', error);
      this.cleanup();
    }
  }

  /** 毎フレーム呼ぶ。ヒットテスト結果でレティクルを動かす */
  onFrame(frame: XRFrame | undefined): void {
    if (!frame || !this.session || !this.hitTestSource) return;
    const refSpace = this.renderer.xr.getReferenceSpace();
    const hit = frame.getHitTestResults(this.hitTestSource)[0];
    const pose = refSpace && hit ? hit.getPose(refSpace) : null;
    if (pose) {
      this.reticle.visible = true;
      this.reticle.matrix.fromArray(pose.transform.matrix);
    } else {
      this.reticle.visible = false;
    }
  }

  /** タップ位置にシーン原点を移す(アバターが視聴者の方を向くようヨーも合わせる) */
  private place(event: XRInputSourceEvent): void {
    const frame = event.frame;
    const base = this.baseRefSpace;
    if (!frame || !base || !this.hitTestSource) return;
    const hit = frame.getHitTestResults(this.hitTestSource)[0];
    const pose = hit?.getPose(base);
    if (!pose) return;

    const p = pose.transform.position;
    const viewer = frame.getViewerPose(base);
    let yaw = 0;
    if (viewer) {
      const v = viewer.transform.position;
      yaw = Math.atan2(v.x - p.x, v.z - p.z); // アバターの正面(+Z)を視聴者へ向ける
    }
    const offset = new XRRigidTransform(
      { x: p.x, y: p.y, z: p.z },
      { x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) },
    );
    this.renderer.xr.setReferenceSpace(base.getOffsetReferenceSpace(offset));
    this.elements.hint.textContent = '設置しました(タップで置き直し)';
  }

  private cleanup(): void {
    this.session = null;
    this.hitTestSource = null;
    this.baseRefSpace = null;
    this.reticle.visible = false;
    this.elements.overlayRoot.hidden = true;
    this.onModeChange(false);
  }
}
