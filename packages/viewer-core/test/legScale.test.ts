/**
 * 体を当てるとき、配信者とアバターで脚の長さの割合が違っても腰の高さを合わせる
 * (脚の長いアバターで膝が曲がりっぱなし、短いアバターで足が浮きっぱなしにならない)
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { VRM } from '@pixiv/three-vrm';
import type { BodySection, PoseSection } from '@xroomcast/protocol';
import { PoseApplier } from '../src/poseApplier';

const identity = [0, 0, 0, 1] as const;

/** 腰の高さ1.0m・脚の長さ約0.96mのアバター(脚だけの骨組み) */
function makeAvatar() {
  const root = new THREE.Object3D();
  const bones: Record<string, THREE.Object3D> = {};
  const add = (name: string, parent: THREE.Object3D, x: number, y: number) => {
    const bone = new THREE.Object3D();
    bone.position.set(x, y, 0);
    parent.add(bone);
    bones[name] = bone;
    return bone;
  };
  const hips = add('hips', root, 0, 1.0);
  for (const [side, x] of [
    ['left', 0.1],
    ['right', -0.1],
  ] as const) {
    const upper = add(`${side}UpperLeg`, hips, x, -0.05);
    const lower = add(`${side}LowerLeg`, upper, 0, -0.45);
    add(`${side}Foot`, lower, 0, -0.45);
  }
  root.updateMatrixWorld(true);
  const vrm = {
    scene: root,
    humanoid: { getNormalizedBoneNode: (name: string) => bones[name] ?? null },
  } as unknown as VRM;
  return { root, bones, applier: new PoseApplier(vrm, root) };
}

const pose: PoseSection = {
  head: { position: [0, 1.5, 0], rotation: [...identity] },
  leftHand: { position: [0.6, 1.3, 0], rotation: [...identity] },
  rightHand: { position: [-0.6, 1.3, 0], rotation: [...identity] },
};

/** 脚の短い配信者が直立している体(腰0.8m・脚の長さ約0.76m) */
const shortLegs: BodySection = {
  hips: { position: [0, 0.8, 0], rotation: [...identity] },
  chest: [...identity],
  leftFoot: { position: [0.1, 0.05, 0], rotation: [...identity] },
  rightFoot: { position: [-0.1, 0.05, 0], rotation: [...identity] },
  leftKnee: [0.1, 0.42, 0.02],
  rightKnee: [-0.1, 0.42, 0.02],
};

describe('脚の長さの比で腰の高さを合わせる', () => {
  it('脚の長いアバターでは腰を上げ、膝を伸ばしたまま足首が目標に届く', () => {
    const { root, bones, applier } = makeAvatar();
    applier.apply({ pose, body: shortLegs });
    root.updateMatrixWorld(true);
    // 足首の中点(0.05)から腰までの0.75mを、脚の比(約1.26倍)で伸ばす
    expect(bones.hips!.position.y).toBeGreaterThan(0.95);
    const foot = bones.leftFoot!.getWorldPosition(new THREE.Vector3());
    expect(foot.distanceTo(new THREE.Vector3(0.1, 0.05, 0))).toBeLessThan(0.01);
    // 膝はほぼ伸びている(下腿のローカル回転が小さい)
    const knee = bones.leftLowerLeg!.quaternion;
    expect(2 * Math.acos(Math.min(1, Math.abs(knee.w))) * (180 / Math.PI)).toBeLessThan(15);
  });

  it('しゃがむと、脚の形を保ったまま腰が下がる', () => {
    const { bones, applier } = makeAvatar();
    applier.apply({ pose, body: shortLegs });
    const standing = bones.hips!.position.y;
    const squat: BodySection = {
      ...shortLegs,
      hips: { position: [0, 0.5, -0.15], rotation: [...identity] },
      leftKnee: [0.1, 0.4, 0.25],
      rightKnee: [-0.1, 0.4, 0.25],
    };
    applier.apply({ pose, body: squat });
    expect(bones.hips!.position.y).toBeLessThan(standing - 0.2);
  });
});
