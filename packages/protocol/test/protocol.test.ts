import { describe, expect, it } from 'vitest';
import {
  decodePacket,
  encodePacket,
  PROTOCOL_VERSION,
  type Packet,
  type PoseNode,
  type Quat,
  type Vec3,
} from '../src/index.js';

// float32に丸めた値で比較する(エンコードでfloat64→float32になるため)
function f32Node(position: Vec3, rotation: Quat): PoseNode {
  return {
    position: position.map(Math.fround) as Vec3,
    rotation: rotation.map(Math.fround) as Quat,
  };
}

function quantized(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255) / 255;
}

describe('encodePacket / decodePacket', () => {
  it('全セクション入りのパケットがラウンドトリップする', () => {
    const packet: Packet = {
      sequence: 1234,
      timestamp: 567890,
      pose: {
        head: f32Node([0.01, 1.35, -0.02], [0.1, -0.2, 0.3, 0.9273]),
        leftHand: f32Node([0.32, 1.4, 0.12], [0, 0.7071, 0, 0.7071]),
        rightHand: f32Node([-0.32, 1.2, 0.12], [0.5, -0.5, 0.5, 0.5]),
      },
      expressions: [
        { id: 0, value: 1 },
        { id: 3, value: 0.5 },
        { id: 255, value: 0 },
      ],
      fingers: {
        leftCurls: [0, 0.25, 0.5, 0.75, 1],
        rightCurls: [1, 0.75, 0.5, 0.25, 0],
        leftSpread: 0.5,
        rightSpread: 1,
      },
      dictionary: [
        { id: 0, name: 'happy' },
        { id: 3, name: 'ウィンク右' },
        { id: 255, name: 'aa' },
      ],
    };

    const decoded = decodePacket(encodePacket(packet));

    expect(decoded.sequence).toBe(1234);
    expect(decoded.timestamp).toBe(567890);
    expect(decoded.pose).toEqual(packet.pose);
    expect(decoded.dictionary).toEqual(packet.dictionary);
    expect(decoded.expressions).toEqual(
      packet.expressions!.map((e) => ({ id: e.id, value: quantized(e.value) })),
    );
    expect(decoded.fingers!.leftCurls).toEqual(packet.fingers!.leftCurls.map(quantized));
    expect(decoded.fingers!.rightCurls).toEqual(packet.fingers!.rightCurls.map(quantized));
    expect(decoded.fingers!.leftSpread).toBe(quantized(0.5));
    expect(decoded.fingers!.rightSpread).toBe(1);
  });

  it('セクションの任意の組み合わせがラウンドトリップする', () => {
    const pose = {
      head: f32Node([0, 1.4, 0], [0, 0, 0, 1]),
      leftHand: f32Node([0.3, 1, 0], [0, 0, 0, 1]),
      rightHand: f32Node([-0.3, 1, 0], [0, 0, 0, 1]),
    };
    const cases: Packet[] = [
      { sequence: 0, timestamp: 0 },
      { sequence: 1, timestamp: 1, pose },
      { sequence: 2, timestamp: 2, expressions: [{ id: 7, value: 0.25 }] },
      {
        sequence: 3,
        timestamp: 3,
        fingers: {
          leftCurls: [0, 0, 0, 0, 0],
          rightCurls: [1, 1, 1, 1, 1],
          leftSpread: 0,
          rightSpread: 1,
        },
      },
      { sequence: 4, timestamp: 4, dictionary: [{ id: 1, name: 'blink' }] },
      { sequence: 5, timestamp: 5, pose, expressions: [], dictionary: [] },
    ];
    for (const packet of cases) {
      const decoded = decodePacket(encodePacket(packet));
      expect(decoded.pose).toEqual(packet.pose);
      expect(decoded.expressions?.length).toBe(packet.expressions?.length);
      expect(decoded.dictionary).toEqual(packet.dictionary);
      expect(decoded.fingers === undefined).toBe(packet.fingers === undefined);
    }
  });

  it('境界値(uint16/uint32の最大、量子化の丸め)を扱える', () => {
    const packet: Packet = {
      sequence: 0xffff,
      timestamp: 0xffffffff,
      expressions: [{ id: 0, value: 0.999 }],
    };
    const decoded = decodePacket(encodePacket(packet));
    expect(decoded.sequence).toBe(0xffff);
    expect(decoded.timestamp).toBe(0xffffffff);
    expect(decoded.expressions![0]!.value).toBe(quantized(0.999));
  });

  it('範囲外の表情値・カール値はクランプして量子化する', () => {
    const decoded = decodePacket(
      encodePacket({
        sequence: 0,
        timestamp: 0,
        expressions: [
          { id: 0, value: -0.5 },
          { id: 1, value: 1.5 },
        ],
      }),
    );
    expect(decoded.expressions![0]!.value).toBe(0);
    expect(decoded.expressions![1]!.value).toBe(1);
  });

  it('ランダムなパケット100個がラウンドトリップする', () => {
    for (let i = 0; i < 100; i++) {
      const rand = (scale: number) => Math.fround((Math.random() - 0.5) * scale);
      const node = (): PoseNode => ({
        position: [rand(4), rand(4), rand(4)],
        rotation: [rand(2), rand(2), rand(2), rand(2)],
      });
      const packet: Packet = {
        sequence: Math.floor(Math.random() * 0x10000),
        timestamp: Math.floor(Math.random() * 0x100000000),
        pose: { head: node(), leftHand: node(), rightHand: node() },
      };
      expect(decodePacket(encodePacket(packet))).toEqual(packet);
    }
  });

  it('未対応バージョンを拒否する', () => {
    const bytes = encodePacket({ sequence: 0, timestamp: 0 });
    bytes[0] = PROTOCOL_VERSION + 1;
    expect(() => decodePacket(bytes)).toThrow(/バージョン/);
  });

  it('壊れたパケット(切り詰め・余分なバイト)を拒否する', () => {
    const bytes = encodePacket({
      sequence: 1,
      timestamp: 1,
      pose: {
        head: f32Node([0, 0, 0], [0, 0, 0, 1]),
        leftHand: f32Node([0, 0, 0], [0, 0, 0, 1]),
        rightHand: f32Node([0, 0, 0], [0, 0, 0, 1]),
      },
    });
    expect(() => decodePacket(bytes.subarray(0, bytes.length - 4))).toThrow();
    const padded = new Uint8Array(bytes.length + 3);
    padded.set(bytes, 0);
    expect(() => decodePacket(padded)).toThrow(/パケット長/);
  });

  it('Uint8Array と ArrayBuffer のどちらも受け付ける', () => {
    const bytes = encodePacket({ sequence: 9, timestamp: 9 });
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    expect(decodePacket(buffer)).toEqual(decodePacket(bytes));
  });
});
