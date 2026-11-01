/**
 * 手首のひねりを前腕へ分ける(twistShare)。分けても手首の位置と最終的な向きは変わらない
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createTwoBoneChain, solveTwoBoneIK } from '../src/twoBoneIK';

/** +X へ伸びるTポーズの左腕(上腕0.3m・前腕0.25m) */
function makeArm() {
  const root = new THREE.Object3D();
  const upper = new THREE.Object3D();
  const lower = new THREE.Object3D();
  const hand = new THREE.Object3D();
  root.add(upper);
  upper.add(lower);
  lower.add(hand);
  lower.position.set(0.3, 0, 0);
  hand.position.set(0.25, 0, 0);
  root.updateMatrixWorld(true);
  const chain = createTwoBoneChain(upper, lower, hand)!;
  return { root, upper, lower, hand, chain };
}

const angleAboutX = (q: THREE.Quaternion): number =>
  2 * Math.atan2(q.x, q.w) * (180 / Math.PI);

function solve(arm: ReturnType<typeof makeArm>, target: THREE.Vector3, quat: THREE.Quaternion, share: number) {
  solveTwoBoneIK(arm.chain, target, quat, new THREE.Vector3(0, -1, -1), share);
  arm.root.updateMatrixWorld(true);
}

describe('手首のひねりの分担', () => {
  it('伸ばした腕で90°ひねると、前腕と手首が45°ずつ受け持つ', () => {
    const arm = makeArm();
    const twist = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
    solve(arm, new THREE.Vector3(0.55, 0, 0), twist, 0.5);
    expect(angleAboutX(arm.lower.quaternion)).toBeCloseTo(45, 3);
    expect(angleAboutX(arm.hand.quaternion)).toBeCloseTo(45, 3);
    expect(arm.hand.getWorldQuaternion(new THREE.Quaternion()).angleTo(twist)).toBeCloseTo(0, 5);
  });

  it('肘を曲げてひねっても、手首の位置と向きは分けない場合と同じ', () => {
    const target = new THREE.Vector3(0.3, -0.2, 0.25);
    const quat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.9, -0.6, 0.4));
    const without = makeArm();
    const withShare = makeArm();
    solve(without, target, quat, 0);
    solve(withShare, target, quat, 0.5);
    const p0 = without.hand.getWorldPosition(new THREE.Vector3());
    const p1 = withShare.hand.getWorldPosition(new THREE.Vector3());
    expect(p1.distanceTo(p0)).toBeLessThan(1e-6);
    const q1 = withShare.hand.getWorldQuaternion(new THREE.Quaternion());
    expect(q1.angleTo(quat)).toBeCloseTo(0, 5);
    // 肘の位置も変わらない(前腕を自分の軸まわりに回しただけ)
    const e0 = without.lower.getWorldPosition(new THREE.Vector3());
    const e1 = withShare.lower.getWorldPosition(new THREE.Vector3());
    expect(e1.distanceTo(e0)).toBeLessThan(1e-6);
    // 手首のローカルのひねりは小さくなっている
    const twistOf = (q: THREE.Quaternion) => Math.abs(angleAboutX(q));
    expect(twistOf(withShare.hand.quaternion)).toBeLessThan(twistOf(without.hand.quaternion) + 1e-6);
  });
});
