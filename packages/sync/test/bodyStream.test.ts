/**
 * 体セクションはポーズと組で補間される。片側にしか無いとき(トラッキングの開始・途切れ)は
 * 時刻の近い方に従う。
 */
import { describe, expect, it } from 'vitest';
import type { BodySection, Packet, PoseSection } from '@xroomcast/protocol';
import { PoseStreamPlayer, TARGET_DELAY_MS } from '../src/poseStream';

const identity = [0, 0, 0, 1] as const;

function pose(y: number): PoseSection {
  return {
    head: { position: [0, y, 0], rotation: [...identity] },
    leftHand: { position: [0.3, 1, 0], rotation: [...identity] },
    rightHand: { position: [-0.3, 1, 0], rotation: [...identity] },
  };
}

function body(hipsY: number): BodySection {
  return {
    hips: { position: [0, hipsY, 0], rotation: [...identity] },
    chest: [...identity],
    leftFoot: { position: [0.1, 0.08, 0], rotation: [...identity] },
    rightFoot: { position: [-0.1, 0.08, 0], rotation: [...identity] },
    leftKnee: [0.1, 0.5, 0.05],
    rightKnee: [-0.1, 0.5, 0.05],
  };
}

/** 2パケット(t=0, t=100)を入れ、その間の時刻 t で取り出す */
function sampleBetween(first: Packet, second: Packet, t: number) {
  const player = new PoseStreamPlayer();
  // 最初のパケットの受信時刻をローカル時刻0とする(=送信時刻0と揃う)
  player.push(first, 0);
  player.push(second, 0);
  return player.sample(t + TARGET_DELAY_MS);
}

describe('体の補間', () => {
  it('両側に体があれば、ポーズと同じ割合で補間する', () => {
    const frame = sampleBetween(
      { sequence: 0, timestamp: 0, pose: pose(1.5), body: body(0.9) },
      { sequence: 1, timestamp: 100, pose: pose(1.6), body: body(0.8) },
      25,
    );
    expect(frame.pose!.head.position[1]).toBeCloseTo(1.525);
    expect(frame.body!.hips.position[1]).toBeCloseTo(0.875);
  });

  it('片側にしか無いときは、時刻の近い方に従う', () => {
    const withBody: Packet = { sequence: 0, timestamp: 0, pose: pose(1.5), body: body(0.9) };
    const without: Packet = { sequence: 1, timestamp: 100, pose: pose(1.5) };
    expect(sampleBetween(withBody, without, 30).body?.hips.position[1]).toBeCloseTo(0.9);
    expect(sampleBetween(withBody, without, 70).body).toBeUndefined();
  });

  it('体を送らない配信元(VMC)では常に無い', () => {
    const frame = sampleBetween(
      { sequence: 0, timestamp: 0, pose: pose(1.5) },
      { sequence: 1, timestamp: 100, pose: pose(1.6) },
      50,
    );
    expect(frame.pose).toBeDefined();
    expect(frame.body).toBeUndefined();
  });
});
