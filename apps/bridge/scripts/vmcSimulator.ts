/**
 * VSeeFaceの代わりにVMC(OSC over UDP)を送るシミュレータ(開発検証用)。
 * Unity座標系(左手系, Y-up, +Z前, 左手=−X)でボーンのローカル姿勢を送る。
 *
 * 使い方:
 *   npm run sim --workspace apps/bridge            # 両手振り+頭揺れ+表情+指
 *   npm run sim --workspace apps/bridge -- right   # 右手だけ挙げる(§7の鏡像確認用)
 * 送信先: VMC_HOST(既定127.0.0.1) : VMC_PORT(既定39539)、60Hz
 */
import dgram from 'node:dgram';
import { toBuffer } from 'osc-min';

const HOST = process.env.VMC_HOST ?? '127.0.0.1';
const PORT = Number(process.env.VMC_PORT ?? 39539);
/**
 * wave: 両手振り+頭揺れ+表情+指
 * right: 右手だけ挙げる(§7の鏡像確認用)
 * glitch: waveに加えて約2秒ごとに1フレームだけ腕がでたらめな方向へ跳ぶ
 *         (VSeeFaceのトラッキングスパイク再現。ブリッジのスパイクフィルタ検証用)
 */
const MODE = (process.argv[2] ?? 'wave') as 'wave' | 'right' | 'glitch';

type V3 = [number, number, number];
type Q4 = [number, number, number, number];

const ID: Q4 = [0, 0, 0, 1];
const TWO_PI = Math.PI * 2;

function axisAngle(axis: V3, angle: number): Q4 {
  const h = angle / 2;
  const s = Math.sin(h);
  return [axis[0] * s, axis[1] * s, axis[2] * s, Math.cos(h)];
}

function quatMul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Tポーズのローカルオフセット(Unity系、身長約1.45mの素体) */
const REST_OFFSETS: Record<string, V3> = {
  Hips: [0, 0.9, 0],
  Spine: [0, 0.1, 0],
  Chest: [0, 0.12, 0],
  UpperChest: [0, 0.12, 0],
  Neck: [0, 0.12, 0],
  Head: [0, 0.08, 0],
  LeftShoulder: [-0.03, 0.1, 0],
  LeftUpperArm: [-0.1, 0, 0],
  LeftLowerArm: [-0.26, 0, 0],
  LeftHand: [-0.25, 0, 0],
  RightShoulder: [0.03, 0.1, 0],
  RightUpperArm: [0.1, 0, 0],
  RightLowerArm: [0.26, 0, 0],
  RightHand: [0.25, 0, 0],
};

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;

const socket = dgram.createSocket('udp4');
const start = performance.now();
let frameCount = 0;

function boneMessage(name: string, pos: V3, rot: Q4) {
  return {
    address: '/VMC/Ext/Bone/Pos',
    args: [
      { type: 'string', value: name },
      { type: 'float', value: pos[0] },
      { type: 'float', value: pos[1] },
      { type: 'float', value: pos[2] },
      { type: 'float', value: rot[0] },
      { type: 'float', value: rot[1] },
      { type: 'float', value: rot[2] },
      { type: 'float', value: rot[3] },
    ],
  };
}

function blendMessage(name: string, value: number) {
  return {
    address: '/VMC/Ext/Blend/Val',
    args: [
      { type: 'string', value: name },
      { type: 'float', value },
    ],
  };
}

function tick(): void {
  frameCount += 1;
  const t = performance.now() - start;
  const wave = (TWO_PI * t) / 2000;
  const sway = (TWO_PI * t) / 2600;

  const rotations = new Map<string, Q4>();

  // 頭: ヨー+ロールの揺れ
  rotations.set(
    'Head',
    quatMul(axisAngle([0, 1, 0], 0.14 * Math.sin(sway)), axisAngle([0, 0, 1], 0.08 * Math.sin(sway + 1.3))),
  );

  // 腕: Unity系で左腕は−X向き。Z軸−90°回転で真上を向く
  if (MODE === 'wave' || MODE === 'glitch') {
    rotations.set('LeftUpperArm', axisAngle([0, 0, 1], -(Math.PI / 2) + 0.3 * Math.sin(wave)));
    rotations.set('LeftLowerArm', axisAngle([0, 0, 1], -0.3 + 0.25 * Math.sin(wave + 0.5)));
    rotations.set('RightUpperArm', axisAngle([0, 0, 1], Math.PI / 2 - 0.3 * Math.sin(wave + Math.PI)));
    rotations.set('RightLowerArm', axisAngle([0, 0, 1], 0.3 - 0.25 * Math.sin(wave + Math.PI + 0.5)));
    // トラッキングスパイク: 120フレームごとに厳密に1フレームだけ腕がでたらめに跳ぶ
    if (MODE === 'glitch' && frameCount % 120 === 0) {
      rotations.set('LeftUpperArm', axisAngle([0, 1, 0], 2.8));
      rotations.set('LeftLowerArm', axisAngle([1, 0, 0], -2.5));
      rotations.set('RightUpperArm', axisAngle([0, 1, 0], -2.8));
    }
  } else {
    // 鏡像確認モード: 右手「だけ」を挙げる。ビューアでもアバターの右手
    // (正面カメラ=観客から見て左)が挙がっていれば§7の変換が正しい
    rotations.set('RightUpperArm', axisAngle([0, 0, 1], Math.PI / 2));
  }

  const messages: ReturnType<typeof boneMessage>[] = [];

  // ルート(ほぼ固定。わずかに揺らして受信側の反映を確認)
  messages.push({
    address: '/VMC/Ext/Root/Pos',
    args: [
      { type: 'string', value: 'root' },
      { type: 'float', value: 0 },
      { type: 'float', value: 0.01 * Math.sin((TWO_PI * t) / 1400) },
      { type: 'float', value: 0 },
      { type: 'float', value: 0 },
      { type: 'float', value: 0 },
      { type: 'float', value: 0 },
      { type: 'float', value: 1 },
    ],
  } as ReturnType<typeof boneMessage>);

  for (const [name, offset] of Object.entries(REST_OFFSETS)) {
    // 体の横揺れ(hipsの平行移動)。ビューア側の足接地固定の確認用
    const pos: V3 =
      name === 'Hips' ? [offset[0] + 0.03 * Math.sin(sway), offset[1], offset[2]] : offset;
    messages.push(boneMessage(name, pos, rotations.get(name) ?? ID));
  }

  // 指: 開閉をサイン波で(位置は原点でよい。ブリッジは回転角しか見ない)
  const curlAngle = 0.5 + 0.45 * Math.sin(wave);
  for (const side of ['Left', 'Right'] as const) {
    for (const finger of FINGERS) {
      for (const segment of SEGMENTS) {
        messages.push(boneMessage(`${side}${finger}${segment}`, [0, 0, 0], axisAngle([0, 0, 1], curlAngle)));
      }
    }
  }

  // 表情(VRM 0.x名で送る=VSeeFace互換)+ Apply
  messages.push(blendMessage('Joy', 0.35 + 0.35 * Math.sin((TWO_PI * t) / 3000)) as ReturnType<typeof boneMessage>);
  messages.push(blendMessage('A', 0.25 + 0.25 * Math.sin((TWO_PI * t) / 900)) as ReturnType<typeof boneMessage>);
  messages.push(blendMessage('Blink', (t % 3400) / 3400 > 0.94 ? 1 : 0) as ReturnType<typeof boneMessage>);
  // 起動5秒後に新しい名前を送り始める(辞書の動的更新の確認用)
  if (t > 5000) {
    messages.push(
      blendMessage('Surprised', 0.25 + 0.25 * Math.sin((TWO_PI * t) / 1700)) as ReturnType<typeof boneMessage>,
    );
  }
  messages.push({ address: '/VMC/Ext/Blend/Apply', args: [] } as unknown as ReturnType<typeof boneMessage>);
  // フレーム区切り(VMC仕様。ブリッジはこれを合図にボーン状態を一括反映する)
  messages.push({
    address: '/VMC/Ext/T',
    args: [{ type: 'float', value: t / 1000 }],
  } as ReturnType<typeof boneMessage>);

  // 実際のVMC送信と同様、1フレームを複数バンドル(UDPパケット)に分けて送る
  const half = Math.ceil(messages.length / 2);
  for (const chunk of [messages.slice(0, half), messages.slice(half)]) {
    socket.send(toBuffer({ oscType: 'bundle', timetag: 0, elements: chunk }), PORT, HOST);
  }
}

setInterval(tick, 1000 / 60);
console.log(`[sim] VMC送信中 → udp://${HOST}:${PORT}(60Hz, mode=${MODE})`);
