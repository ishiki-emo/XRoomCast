/**
 * ダミーモーション生成器(実装仕様書 §5 Phase 2a)。
 * サイン波で「両手を振りながら頭が揺れる」30Hzのポーズストリームを§6形式で生成する。
 * 時刻の純関数なので、CLIでのファイル保存とビューアでの実時間再生の両方から使える。
 * 座標系はワイヤ仕様どおりThree.js系(右手系, Y-up, モデル正面+Z, 原点=足元)。
 */
import type { DictionaryEntry, FingerCurls, Packet, PoseSection, Quat } from '@xroomcast/protocol';

export const POSE_RATE = 30;
export const POSE_INTERVAL_MS = 1000 / POSE_RATE;

/** three-vrm のプリセット表情名に合わせた辞書 */
export const DEMO_DICTIONARY: DictionaryEntry[] = [
  { id: 0, name: 'happy' },
  { id: 1, name: 'aa' },
  { id: 2, name: 'blink' },
];

const TWO_PI = Math.PI * 2;

function axisAngleZ(angle: number): Quat {
  return [0, 0, Math.sin(angle / 2), Math.cos(angle / 2)];
}

function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

function dummyPose(tMs: number): PoseSection {
  const wave = (TWO_PI * tMs) / 2000; // 手振り: 2秒周期
  const sway = (TWO_PI * tMs) / 2600; // 頭揺れ: 2.6秒周期

  // 頭: ヨー±8°+ロール±4.5°の揺れ(headボーンのローカル回転として適用される)
  const yaw = 0.14 * Math.sin(sway);
  const roll = 0.08 * Math.sin(sway + 1.3);
  const headRot = quatMul(
    [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)],
    [0, 0, Math.sin(roll / 2), Math.cos(roll / 2)],
  );

  // 手: 指先を上に向けた状態(Z軸±90°)で上下に振る。左右は逆位相
  return {
    head: {
      // 横揺れ(±4cm)を入れて、足の接地固定が効いていることを確認できるようにする
      position: [
        0.04 * Math.sin(sway),
        1.35 + 0.015 * Math.sin((TWO_PI * tMs) / 1400),
        0,
      ],
      rotation: headRot,
    },
    leftHand: {
      position: [
        0.32 + 0.04 * Math.sin(wave + Math.PI),
        1.3 + 0.17 * Math.sin(wave),
        0.12,
      ],
      rotation: axisAngleZ(Math.PI / 2 + 0.35 * Math.sin(wave)),
    },
    rightHand: {
      position: [
        -0.32 - 0.04 * Math.sin(wave),
        1.3 + 0.17 * Math.sin(wave + Math.PI),
        0.12,
      ],
      rotation: axisAngleZ(-Math.PI / 2 - 0.35 * Math.sin(wave + Math.PI)),
    },
  };
}

/**
 * tMs 時点のパケットを生成する。
 * - ポーズ: 毎パケット(30Hz)
 * - 表情・手指: 2パケットに1回(15Hz)。サイン波で毎回値が変わるため
 *   デルタ方式(§6.3)でも実質全エントリが送られる
 * - 辞書: 30パケットに1回(1秒ごと)。ドロップ・途中参加対策の定期再送
 */
export function dummyPacketAt(tMs: number, sequence: number): Packet {
  const packet: Packet = {
    sequence: sequence & 0xffff,
    timestamp: Math.round(tMs) >>> 0,
    pose: dummyPose(tMs),
  };

  if (sequence % 2 === 0) {
    const blinkPhase = (tMs % 3400) / 3400;
    packet.expressions = [
      { id: 0, value: 0.35 + 0.35 * Math.sin((TWO_PI * tMs) / 3000) },
      { id: 1, value: 0.25 + 0.25 * Math.sin((TWO_PI * tMs) / 900) },
      { id: 2, value: blinkPhase > 0.94 ? 1 : 0 },
    ];

    const wave = (TWO_PI * tMs) / 2000;
    const curl = (phase: number) => 0.25 + 0.25 * Math.sin(wave + phase);
    packet.fingers = {
      leftCurls: [curl(0), curl(0.4), curl(0.8), curl(1.2), curl(1.6)] as FingerCurls,
      rightCurls: [curl(1.6), curl(1.2), curl(0.8), curl(0.4), curl(0)] as FingerCurls,
      leftSpread: 0.5 + 0.3 * Math.sin((TWO_PI * tMs) / 2200),
      rightSpread: 0.5 + 0.3 * Math.sin((TWO_PI * tMs) / 2200 + Math.PI),
    };
  }

  if (sequence % 30 === 0) {
    packet.dictionary = DEMO_DICTIONARY;
  }

  return packet;
}
