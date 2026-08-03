/**
 * slerpQuat は three.js の Quaternion.slerpFlat の移植なので、
 * 本家と数値が一致することを突き合わせて確認する。
 * (three はこのテストのためだけの devDependency。本体は three に依存しない)
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { Quat } from '@xroomcast/protocol';
import { slerpQuat } from '../src/quaternion';

function reference(a: Quat, b: Quat, t: number): number[] {
  const out = [0, 0, 0, 1];
  THREE.Quaternion.slerpFlat(out, 0, a as unknown as number[], 0, b as unknown as number[], 0, t);
  return out;
}

function normalized(x: number, y: number, z: number, w: number): Quat {
  const len = Math.hypot(x, y, z, w);
  return [x / len, y / len, z / len, w / len];
}

/** 決定的な擬似乱数(テストを再現可能にする) */
function makeRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

const IDENTITY: Quat = [0, 0, 0, 1];

describe('slerpQuat', () => {
  it('端点はそのまま返す', () => {
    const a = normalized(0.3, 0.1, -0.2, 0.9);
    const b = normalized(-0.4, 0.5, 0.2, 0.7);
    expect(slerpQuat(a, b, 0)).toEqual([a[0], a[1], a[2], a[3]]);
    expect(slerpQuat(a, b, 1)).toEqual([b[0], b[1], b[2], b[3]]);
  });

  it('同一の姿勢どうしはそのまま返す(0除算にならない)', () => {
    const a = normalized(0.2, 0.4, 0.1, 0.8);
    expect(slerpQuat(a, [...a] as Quat, 0.5)).toEqual([a[0], a[1], a[2], a[3]]);
  });

  it('90度回転の中間はちょうど45度になる', () => {
    const half = Math.SQRT1_2;
    const ninety: Quat = [0, half, 0, half]; // Y軸まわり90度
    const mid = slerpQuat(IDENTITY, ninety, 0.5);
    const angle = 2 * Math.acos(Math.min(1, Math.abs(mid[3])));
    expect(angle).toBeCloseTo(Math.PI / 4, 12);
  });

  it('鈍角のペアでは最短経路(反転側)を通る', () => {
    const a: Quat = [0, 0, 0, 1];
    const b: Quat = [0, 0, 0, -1]; // aと同じ姿勢だが符号が逆
    const mid = slerpQuat(a, b, 0.5);
    // 遠回りせず単位元付近に留まる
    expect(Math.abs(mid[3])).toBeCloseTo(1, 12);
  });

  it('無作為な組み合わせで three.js と一致する', () => {
    const random = makeRandom(20260803);
    for (let i = 0; i < 500; i += 1) {
      const a = normalized(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      const b = normalized(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      const t = random();
      const mine = slerpQuat(a, b, t);
      const theirs = reference(a, b, t);
      for (let axis = 0; axis < 4; axis += 1) {
        expect(mine[axis]).toBeCloseTo(theirs[axis]!, 15);
      }
    }
  });

  it('ほぼ同一の姿勢(線形補間へ落ちる経路)でも three.js と一致する', () => {
    const a: Quat = [0, 0, 0, 1];
    const b = normalized(1e-9, 0, 0, 1);
    for (const t of [0.25, 0.5, 0.75]) {
      const mine = slerpQuat(a, b, t);
      const theirs = reference(a, b, t);
      for (let axis = 0; axis < 4; axis += 1) {
        expect(mine[axis]).toBeCloseTo(theirs[axis]!, 15);
      }
    }
  });
});
