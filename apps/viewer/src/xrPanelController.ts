/**
 * XR中の空間パネル操作(コントローラのレイ+トリガー)。
 *
 * ar.ts の ArController にも同種の処理があるが、あちらはアバターのつかみ移動や
 * 設置と強く結びついている。ここでは「パネルを指して押す」だけを切り出して、
 * 配信者コンソールのように設置機能を持たない画面から使えるようにしている。
 */
import * as THREE from 'three';
import type { ArPanel } from './spatialUI';

const LASER_DEFAULT_LEN = 1.5;

const _matrix = new THREE.Matrix4();
const _raycaster = new THREE.Raycaster();
const _quat = new THREE.Quaternion();
const _offset = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

export class XrPanelController {
  private readonly controllers: THREE.XRTargetRaySpace[];
  private readonly lasers: THREE.Line[];
  /** 各手のレイが指しているパネルとボタン */
  private readonly hits: { panel: ArPanel | null; index: number }[] = [
    { panel: null, index: -1 },
    { panel: null, index: -1 },
  ];
  private enabled = false;

  constructor(
    renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
    private readonly panels: ArPanel[],
  ) {
    for (const panel of panels) scene.add(panel.object);

    this.controllers = [renderer.xr.getController(0), renderer.xr.getController(1)];
    const geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      new THREE.Vector3(0, 0, -1),
    ]);
    this.lasers = [0, 1].map(() => {
      const laser = new THREE.Line(
        geometry,
        new THREE.LineBasicMaterial({ color: 0x8fd0ff, transparent: true, opacity: 0.7 }),
      );
      laser.visible = false;
      return laser;
    });

    for (const i of [0, 1] as const) {
      const controller = this.controllers[i]!;
      controller.add(this.lasers[i]!);
      controller.addEventListener('selectstart', () => this.onSelect(i));
      scene.add(controller);
    }
  }

  /**
   * パネルの表示。基準の位置と向き(配信者の立ち位置)を渡すと、その前方へ並べる。
   * 向きは arPlacement.yaw ではなく「常に基準位置の方を向く」ように計算する
   * (置く位置を変えても正面がこちらを向く)
   */
  show(origin: THREE.Vector3, yawAngle: number): void {
    this.enabled = true;
    for (const laser of this.lasers) laser.visible = true;
    for (const panel of this.panels) {
      _quat.setFromAxisAngle(UP, yawAngle);
      _offset.copy(panel.arPlacement.position).applyQuaternion(_quat).add(origin);
      // パネルの表面は+Z。基準位置へ向ける
      _quat.setFromAxisAngle(UP, Math.atan2(origin.x - _offset.x, origin.z - _offset.z));
      panel.show(_offset, _quat);
    }
  }

  hide(): void {
    this.enabled = false;
    for (const laser of this.lasers) laser.visible = false;
    for (const panel of this.panels) panel.hide();
  }

  /** いずれかの手がパネルを指しているか(トリガーの用途を分けるのに使う) */
  get pointing(): boolean {
    return this.hits.some((hit) => hit.panel !== null);
  }

  private onSelect(index: 0 | 1): void {
    if (!this.enabled) return;
    const hit = this.hits[index]!;
    if (hit.panel && hit.index >= 0) hit.panel.activate(hit.index);
  }

  /** 毎フレーム呼ぶ。レイの当たり判定とホバー表示を更新する */
  update(): void {
    if (!this.enabled) return;
    const hover = new Map<ArPanel, number>();

    for (const i of [0, 1] as const) {
      const controller = this.controllers[i]!;
      const laser = this.lasers[i]!;
      _matrix.identity().extractRotation(controller.matrixWorld);
      _raycaster.ray.origin.setFromMatrixPosition(controller.matrixWorld);
      _raycaster.ray.direction.set(0, 0, -1).applyMatrix4(_matrix);

      let best: { panel: ArPanel; index: number; distance: number } | null = null;
      for (const panel of this.panels) {
        const hit = panel.raycast(_raycaster);
        if (hit && (!best || hit.distance < best.distance)) {
          best = { panel, index: hit.index, distance: hit.distance };
        }
      }
      this.hits[i] = best ? { panel: best.panel, index: best.index } : { panel: null, index: -1 };
      laser.scale.z = best ? best.distance : LASER_DEFAULT_LEN;
      if (best && best.index >= 0) hover.set(best.panel, best.index);
    }

    for (const panel of this.panels) panel.setHover(hover.get(panel) ?? -1);
  }
}
