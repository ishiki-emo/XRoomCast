/**
 * AR視聴者自身の手でアバターを隠す(ハンドトラッキングの関節から作る手の形の遮り物)。
 *
 * 深度センサーの深度は粗く少し遅れて届くので、近くて速く動く手は輪郭がギザギザになる。
 * 手は関節の位置と太さがトラッキングで正確に取れるので、その形で隠したほうがきれい。
 *
 * ただ手の形を重ねるだけだと、深度センサーの粗い手の像がその外側にはみ出して残る。
 * そこで描く順を3段にする(renderOrder で並べる。数字が小さいほど先):
 *
 * 1. 深度センサーの深度を書く(depthOcclusion.ts、-100)
 * 2. 手の少し外側までを「何も無い」(深度1.0=遠方面)に書き戻す(マスク、-90)。
 *    ここで深度センサーの手の像を消す
 * 3. 正確な手の形の深度を書く(-80)。平面オクルーダー(-1)とアバター(0)はその後
 *
 * どれも色は描かず深度だけ書く。手のメッシュは関節ごとの球と、骨ごとの円柱で組む
 * (インスタンス描画なので、両手でも4回の描画で済む)
 */
import * as THREE from 'three';

/** XRHand の関節数(手首+指ごとに5、親指は4) */
const JOINT_COUNT = 25;
const HANDS = 2;

/**
 * 骨(円柱でつなぐ関節の組)。指は付け根から指先まで、手首から各指の中手骨へ。
 * 手のひらに隙間ができないよう、隣り合う指の中手骨と付け根どうしもつなぐ
 */
const BONES: readonly (readonly [number, number])[] = (() => {
  const bones: [number, number][] = [];
  // 親指 1..4、人差し指 5..9、中指 10..14、薬指 15..19、小指 20..24
  bones.push([0, 1], [1, 2], [2, 3], [3, 4]);
  for (const start of [5, 10, 15, 20]) {
    bones.push([0, start]);
    for (let j = start; j < start + 4; j++) bones.push([j, j + 1]);
  }
  bones.push([5, 10], [10, 15], [15, 20]); // 中手骨
  bones.push([6, 11], [11, 16], [16, 21]); // 指の付け根
  bones.push([1, 5], [2, 6]); // 親指と人差し指の間
  return bones;
})();

/** 正確な手の形の太さに足す量(メートル)。トラッキングと実物の差を少し覆う */
const HAND_PADDING = 0.004;
/** マスク(深度センサーを使わない範囲)の太さに足す量(メートル)。センサーの手の像のはみ出しを覆う */
const MASK_PADDING = 0.03;

/** マスク用。インスタンスごとの位置で描き、深度を遠方面(1.0)へ書き戻す */
const MASK_VERTEX = `
void main() {
	vec4 p = vec4( position, 1.0 );
	#ifdef USE_INSTANCING
	p = instanceMatrix * p;
	#endif
	gl_Position = projectionMatrix * modelViewMatrix * p;
}`;
const MASK_FRAGMENT = `
void main() {
	gl_FragDepth = 1.0;
}`;

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _mid = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _m = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);

interface Layer {
  spheres: THREE.InstancedMesh;
  bones: THREE.InstancedMesh;
  padding: number;
}

export class HandOccluder {
  private readonly layers: Layer[];
  /** 関節の位置と太さ(手ごと) */
  private readonly positions = Array.from({ length: HANDS }, () =>
    Array.from({ length: JOINT_COUNT }, () => new THREE.Vector3()),
  );
  private readonly radii = Array.from({ length: HANDS }, () => new Float32Array(JOINT_COUNT));

  constructor(scene: THREE.Scene) {
    const sphere = new THREE.SphereGeometry(1, 12, 8);
    // 高さ1・Y軸向き・中心が原点。両端は球が埋めるので蓋は要らない
    const cylinder = new THREE.CylinderGeometry(1, 1, 1, 10, 1, true);
    const exact = new THREE.MeshBasicMaterial({ colorWrite: false });
    const mask = new THREE.ShaderMaterial({
      vertexShader: MASK_VERTEX,
      fragmentShader: MASK_FRAGMENT,
      colorWrite: false,
      // 深度センサーが書いた値より奥(1.0)へ書き戻すので、深度テストは常に通す
      depthFunc: THREE.AlwaysDepth,
    });
    const make = (material: THREE.Material, padding: number, renderOrder: number): Layer => {
      const spheres = new THREE.InstancedMesh(sphere, material, HANDS * JOINT_COUNT);
      const bones = new THREE.InstancedMesh(cylinder, material, HANDS * BONES.length);
      for (const mesh of [spheres, bones]) {
        mesh.frustumCulled = false; // インスタンスの位置は元の形の境界球と無関係
        mesh.renderOrder = renderOrder;
        mesh.count = 0;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        scene.add(mesh);
      }
      return { spheres, bones, padding };
    };
    this.layers = [make(mask, MASK_PADDING, -90), make(exact, HAND_PADDING, -80)];
  }

  /** 毎フレーム呼ぶ(描画の前)。手が取れていなければ何も描かない */
  update(frame: XRFrame, refSpace: XRReferenceSpace | null): void {
    let hands = 0;
    if (refSpace) {
      for (const source of frame.session.inputSources) {
        if (!source.hand || hands >= HANDS) continue;
        if (this.readHand(frame, source.hand, refSpace, hands)) hands += 1;
      }
    }
    for (const layer of this.layers) this.fill(layer, hands);
  }

  hide(): void {
    for (const layer of this.layers) {
      layer.spheres.count = 0;
      layer.bones.count = 0;
    }
  }

  /** 1本の手の全関節を読む。1つでも欠けたら使わない(半端な形で隠すと目立つ) */
  private readHand(
    frame: XRFrame,
    hand: XRHand,
    refSpace: XRReferenceSpace,
    slot: number,
  ): boolean {
    let i = 0;
    for (const space of hand.values()) {
      if (i >= JOINT_COUNT) break;
      const pose = frame.getJointPose?.(space, refSpace);
      if (!pose) return false;
      const p = pose.transform.position;
      this.positions[slot]![i]!.set(p.x, p.y, p.z);
      this.radii[slot]![i] = pose.radius ?? 0.008;
      i += 1;
    }
    return i === JOINT_COUNT;
  }

  private fill(layer: Layer, hands: number): void {
    let sphereCount = 0;
    let boneCount = 0;
    for (let h = 0; h < hands; h++) {
      const positions = this.positions[h]!;
      const radii = this.radii[h]!;
      for (let j = 0; j < JOINT_COUNT; j++) {
        const r = radii[j]! + layer.padding;
        _m.compose(positions[j]!, _q.identity(), _s.set(r, r, r));
        layer.spheres.setMatrixAt(sphereCount++, _m);
      }
      for (const [from, to] of BONES) {
        _a.copy(positions[from]!);
        _b.copy(positions[to]!);
        const length = _dir.subVectors(_b, _a).length();
        if (length < 1e-4) continue;
        const r = Math.min(radii[from]!, radii[to]!) + layer.padding;
        _mid.addVectors(_a, _b).multiplyScalar(0.5);
        _q.setFromUnitVectors(UP, _dir.divideScalar(length));
        _m.compose(_mid, _q, _s.set(r, length, r));
        layer.bones.setMatrixAt(boneCount++, _m);
      }
    }
    layer.spheres.count = sphereCount;
    layer.bones.count = boneCount;
    layer.spheres.instanceMatrix.needsUpdate = true;
    layer.bones.instanceMatrix.needsUpdate = true;
  }
}
