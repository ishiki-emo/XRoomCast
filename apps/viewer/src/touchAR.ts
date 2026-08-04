/**
 * スマホAR(Chrome/ARCore等)向けのタッチ操作。
 * VRコントローラが無い端末では grip/squeeze が発火しないため、DOMオーバーレイの
 * タッチレイヤーでジェスチャを拾って操作する:
 * - タップ: パネルのボタンなら選択、そうでなければアバターを設置(レティクル位置)
 * - 1本指ドラッグ(パネル上): そのパネルを掴んで移動(指の先へ追従、正面はカメラ向き)
 * - 1本指ドラッグ(それ以外): アバターをヨー回転
 * - 2本指ピンチ: アバターを伸縮 / ひねりで回転(足元固定)
 * 座標はXRのビューカメラから画面タッチ位置のレイを起こして解決する。
 */
import * as THREE from 'three';
import type { ArPanel } from './spatialUI';

const SCALE_MIN = 0.1;
const SCALE_MAX = 3;
const TAP_MOVE_PX = 12;
const TAP_MS = 350;
const UP = new THREE.Vector3(0, 1, 0);

export interface TouchAROptions {
  touchEl: HTMLElement;
  renderer: THREE.WebGLRenderer;
  /** 部屋の配置フレーム。回転・伸縮はこのグループへ適用する */
  roomSpace: THREE.Group;
  panels: ArPanel[];
  place: () => void;
  onScaleChanged: (scale: number) => void;
  setHint: (text: string) => void;
}

export class TouchAR {
  private enabled = false;
  private readonly pointers = new Map<number, { x: number; y: number }>();
  private readonly startInfo = new Map<number, { x: number; y: number; t: number }>();
  private mode: 'none' | 'panel' | 'rotate' | 'pinch' = 'none';
  private panelDrag: { panel: ArPanel; distance: number } | null = null;
  private rotateStart = { x: 0, yaw: 0 };
  private pinchStart = { dist: 1, angle: 0, scale: 1, yaw: 0 };

  private readonly raycaster = new THREE.Raycaster();
  private readonly _projInv = new THREE.Matrix4();
  private readonly _v = new THREE.Vector3();

  constructor(private readonly o: TouchAROptions) {
    const el = o.touchEl;
    el.addEventListener('pointerdown', this.onDown);
    el.addEventListener('pointermove', this.onMove);
    el.addEventListener('pointerup', this.onUp);
    el.addEventListener('pointercancel', this.onUp);
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) {
      this.pointers.clear();
      this.startInfo.clear();
      this.mode = 'none';
      this.panelDrag = null;
    }
  }

  private viewCamera(): THREE.PerspectiveCamera {
    const c = this.o.renderer.xr.getCamera();
    return (c.cameras.length ? c.cameras[0]! : c) as THREE.PerspectiveCamera;
  }

  /** 画面座標(px)からワールドのレイを raycaster にセットする */
  private setRay(x: number, y: number): void {
    const cam = this.viewCamera();
    const ndcX = (x / window.innerWidth) * 2 - 1;
    const ndcY = -(y / window.innerHeight) * 2 + 1;
    // XRサブカメラは projectionMatrixInverse が更新されないため自前で反転する
    this._projInv.copy(cam.projectionMatrix).invert();
    this.raycaster.ray.origin.setFromMatrixPosition(cam.matrixWorld);
    this._v.set(ndcX, ndcY, 0.5).applyMatrix4(this._projInv).applyMatrix4(cam.matrixWorld);
    this.raycaster.ray.direction.copy(this._v).sub(this.raycaster.ray.origin).normalize();
  }

  private currentYaw(): number {
    const q = this.o.roomSpace.quaternion;
    return Math.atan2(2 * (q.w * q.y + q.x * q.z), 1 - 2 * (q.y * q.y + q.x * q.x));
  }

  private onDown = (e: PointerEvent): void => {
    if (!this.enabled) return;
    e.preventDefault();
    try {
      this.o.touchEl.setPointerCapture(e.pointerId);
    } catch {
      // アクティブなポインタが無い等の失敗は無視(ジェスチャ処理は続行)
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.startInfo.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });

    if (this.pointers.size === 1) {
      this.setRay(e.clientX, e.clientY);
      let best: { panel: ArPanel; distance: number } | null = null;
      for (const panel of this.o.panels) {
        const hit = panel.raycast(this.raycaster);
        if (hit && (!best || hit.distance < best.distance)) best = { panel, distance: hit.distance };
      }
      if (best) {
        this.panelDrag = best;
        this.mode = 'panel';
        this.o.setHint('パネルを移動');
      } else {
        this.mode = 'rotate';
        this.rotateStart = { x: e.clientX, yaw: this.currentYaw() };
      }
    } else if (this.pointers.size === 2) {
      this.beginPinch();
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.enabled || !this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.mode === 'pinch' && this.pointers.size >= 2) this.updatePinch();
    else if (this.mode === 'panel' && this.panelDrag) this.updatePanelDrag(e.clientX, e.clientY);
    else if (this.mode === 'rotate') this.updateRotate(e.clientX);
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    e.preventDefault();
    const start = this.startInfo.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    this.startInfo.delete(e.pointerId);

    if (this.pointers.size === 0) {
      const moved = start ? Math.hypot(e.clientX - start.x, e.clientY - start.y) : 999;
      const dt = start ? performance.now() - start.t : 999;
      if (this.mode !== 'pinch' && moved < TAP_MOVE_PX && dt < TAP_MS) {
        this.handleTap(e.clientX, e.clientY);
      }
      this.mode = 'none';
      this.panelDrag = null;
    } else if (this.pointers.size === 1) {
      // 2本指→1本指: 残った指で回転を再スタート(値の飛びを防ぐ)
      const remaining = [...this.pointers.values()][0]!;
      this.mode = 'rotate';
      this.rotateStart = { x: remaining.x, yaw: this.currentYaw() };
      this.panelDrag = null;
    }
  };

  private handleTap(x: number, y: number): void {
    this.setRay(x, y);
    for (const panel of this.o.panels) {
      const hit = panel.raycast(this.raycaster);
      if (hit && hit.index >= 0) {
        panel.activate(hit.index);
        return;
      }
      if (hit) return; // パネル面のタップは何もしない
    }
    this.o.place();
  }

  private updateRotate(x: number): void {
    const dx = x - this.rotateStart.x;
    const yaw = this.rotateStart.yaw + (dx / window.innerWidth) * Math.PI * 2;
    this.o.roomSpace.quaternion.setFromAxisAngle(UP, yaw);
  }

  private updatePanelDrag(x: number, y: number): void {
    if (!this.panelDrag) return;
    this.setRay(x, y);
    this.raycaster.ray.at(this.panelDrag.distance, this.panelDrag.panel.object.position);
    this.panelDrag.panel.object.quaternion.copy(this.viewCamera().quaternion); // カメラを向く
  }

  private beginPinch(): void {
    const [a, b] = [...this.pointers.values()];
    this.mode = 'pinch';
    this.pinchStart = {
      dist: Math.max(Math.hypot(a!.x - b!.x, a!.y - b!.y), 1),
      angle: Math.atan2(b!.y - a!.y, b!.x - a!.x),
      scale: this.o.roomSpace.scale.x,
      yaw: this.currentYaw(),
    };
    this.o.setHint('二本指で伸縮・回転');
  }

  private updatePinch(): void {
    const [a, b] = [...this.pointers.values()];
    const dist = Math.max(Math.hypot(a!.x - b!.x, a!.y - b!.y), 1);
    const angle = Math.atan2(b!.y - a!.y, b!.x - a!.x);
    const scale = THREE.MathUtils.clamp(
      this.pinchStart.scale * (dist / this.pinchStart.dist),
      SCALE_MIN,
      SCALE_MAX,
    );
    this.o.roomSpace.scale.setScalar(scale);
    this.o.onScaleChanged(scale);
    // 画面上のひねり → ヨー回転(足元中心・位置は不変)
    const yaw = this.pinchStart.yaw - (angle - this.pinchStart.angle);
    this.o.roomSpace.quaternion.setFromAxisAngle(UP, yaw);
  }
}
