/**
 * アバターの均一スケール変更に、「ワールド単位」で定義されている
 * サブシステムを追従させるアダプタ(卓上モード用)。
 *
 * - スプリングボーン: 静止長がワールド単位で初期化時に記録されるため、
 *   スケール後に setInitState() で再キャプチャする。gravityPower /
 *   hitRadius / コライダー半径もワールド単位なのでスケール倍する
 * - MToonアウトライン: worldCoordinatesモードの幅はメートル指定のため、
 *   スケール倍しないと縮小時に相対的に太くなる
 */
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';

interface MToonLike extends THREE.Material {
  outlineWidthMode: string;
  outlineWidthFactor: number;
}

interface JointSettings {
  gravityPower: number;
  hitRadius: number;
}

export class AvatarScaleAdapter {
  private readonly joints: { settings: JointSettings; gravityPower: number; hitRadius: number }[] =
    [];
  private readonly colliders: { shape: { radius: number }; radius: number }[] = [];
  private readonly outlines: { material: MToonLike; factor: number }[] = [];
  private lastScale = 1;

  constructor(private readonly vrm: VRM) {
    for (const joint of vrm.springBoneManager?.joints ?? []) {
      this.joints.push({
        settings: joint.settings,
        gravityPower: joint.settings.gravityPower,
        hitRadius: joint.settings.hitRadius,
      });
    }
    for (const collider of vrm.springBoneManager?.colliders ?? []) {
      const shape = collider.shape as unknown as { radius?: number };
      if (typeof shape.radius === 'number') {
        this.colliders.push({ shape: shape as { radius: number }, radius: shape.radius });
      }
    }
    vrm.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        const m = material as MToonLike;
        if (typeof m.outlineWidthFactor === 'number' && m.outlineWidthMode === 'worldCoordinates') {
          this.outlines.push({ material: m, factor: m.outlineWidthFactor });
        }
      }
    });
  }

  apply(scale: number): void {
    if (Math.abs(scale - this.lastScale) < 1e-4) return;
    this.lastScale = scale;
    for (const j of this.joints) {
      j.settings.gravityPower = j.gravityPower * scale;
      j.settings.hitRadius = j.hitRadius * scale;
    }
    for (const c of this.colliders) {
      c.shape.radius = c.radius * scale;
    }
    for (const o of this.outlines) {
      o.material.outlineWidthFactor = o.factor * scale;
    }
    // 静止長・軸を現在のワールドスケールで再キャプチャ(これをしないと
    // 「等身大の静止長を維持しようとして」揺れものが暴れる)
    this.vrm.scene.updateWorldMatrix(true, true);
    this.vrm.springBoneManager?.setInitState();
  }
}
