/**
 * Webカメラの推定結果(webcamTracking.ts)を、ワイヤの頭・手・指・表情へ直す計算。
 *
 * 座標の対応: カメラは配信者の正面にあり、アバターも視聴者の方(+Z)を向いている。
 * 本人の左は画面の右(+x)で、アバターの左(+X)と一致する。だから
 * - 顔の変換行列(x=右, y=上, z=カメラ側)は、そのままワイヤの向きとして使える
 * - 体・手の3D(x=右, y=下, z=奥)は、y と z の符号を反転するだけでよい
 * 本人が右手を上げればアバターも右手を上げる(向かい合った人と同じ見え方。VSeeFaceと同じ)
 */
import * as THREE from 'three';
import type { FingerCurls } from '@xroomcast/protocol';
import type { Landmark, NormalizedLandmark } from '@mediapipe/tasks-vision';
import { curlFromPoints, spreadFromDirs } from './handTracking';
import type { HandReading, PoseReading } from './webcamTracking';

/** 体の推定の番号(MediaPipe Pose)。左右は本人から見た左右 */
export const POSE = {
  leftEar: 7,
  rightEar: 8,
  leftElbow: 13,
  rightElbow: 14,
  leftWrist: 15,
  rightWrist: 16,
} as const;

/** 手の関節の番号(MediaPipe Hand)。指は付け根から指先の順。親指以外は手首から始める */
const FINGERS: readonly (readonly number[])[] = [
  [1, 2, 3, 4],
  [0, 5, 6, 7, 8],
  [0, 9, 10, 11, 12],
  [0, 13, 14, 15, 16],
  [0, 17, 18, 19, 20],
];

/** 体・手の3Dをワイヤの向きへ(y と z を反転) */
export function toWire(l: Landmark, out: THREE.Vector3): THREE.Vector3 {
  return out.set(l.x, -l.y, -l.z);
}

/**
 * 手の向き。ワイヤの手の回転は「Tポーズの手からの回転」で、Tポーズでは
 * 指先が左手は+X・右手は-X、親指が+Z、手のひらが-Y(poseApplier参照)。
 * 指先の向きと親指側の向きから、その3軸がいまどこを向いているかの回転を組む
 */
export function handRotation(
  side: 'left' | 'right',
  fingerDir: THREE.Vector3,
  thumbDir: THREE.Vector3,
  out: THREE.Quaternion,
): THREE.Quaternion {
  const x = _x.copy(fingerDir).normalize();
  if (side === 'right') x.negate();
  // 親指側を指先の向きと直交させる(右手系を保つため、残りの軸は外積で決める)
  const z = _z.copy(thumbDir).normalize();
  z.addScaledVector(x, -z.dot(x));
  // 親指側が指先とほぼ平行(手の形が崩れた推定や、下ろした腕に「親指が上」を当てたとき)は、
  // 向きが定まらず暴れるので前(+Z)を親指側にする
  if (z.lengthSq() < 0.04) z.set(0, 0, 1).addScaledVector(x, -x.z);
  z.normalize();
  const y = _y.crossVectors(z, x);
  return out.setFromRotationMatrix(_basis.makeBasis(x, y, z));
}

/** 指の曲がり具合と開き具合(手の3Dから) */
export function fingersFromHand(world: Landmark[]): { curls: FingerCurls; spread: number } {
  const curls = [0, 0, 0, 0, 0] as FingerCurls;
  FINGERS.forEach((joints, f) => {
    const points = joints.map((index, j) => toWire(world[index]!, _points[j]!));
    curls[f] = curlFromPoints(points, f === 0);
  });
  toWire(world[6]!, _a).sub(toWire(world[5]!, _b));
  const indexDir = _indexDir.copy(_a);
  toWire(world[18]!, _a).sub(toWire(world[17]!, _b));
  return { curls, spread: spreadFromDirs(indexDir, _a) };
}

/** 手の3Dから、指先の向き(手首→中指の付け根)と親指側の向き(小指の付け根→人差し指の付け根) */
export function handAxes(
  world: Landmark[],
  fingerOut: THREE.Vector3,
  thumbOut: THREE.Vector3,
): void {
  toWire(world[9]!, fingerOut).sub(toWire(world[0]!, _a));
  toWire(world[5]!, thumbOut).sub(toWire(world[17]!, _a));
}

/**
 * 検出した手が本人のどちらの手か。体の推定の手首(画像上)に近い方を採る。
 * 体が取れないときは MediaPipe の左右ラベルを使う。ラベルは、反転していないカメラ映像で
 * 本人の左右と一致する(tasks-vision 1.1.1 の写真で確認。古い説明にある「鏡像を前提」とは逆)
 */
export function sideOfHand(hand: HandReading, pose: PoseReading | null): 'left' | 'right' {
  const wrist = hand.image[0]!;
  if (pose) {
    const dist = (l: NormalizedLandmark | undefined) =>
      l ? Math.hypot(l.x - wrist.x, l.y - wrist.y) : Infinity;
    return dist(pose.image[POSE.leftWrist]) <= dist(pose.image[POSE.rightWrist]) ? 'left' : 'right';
  }
  return hand.label === 'Right' ? 'right' : 'left';
}

function remap(value: number | undefined, from: number, to: number): number {
  const v = ((value ?? 0) - from) / (to - from);
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 送る表情の名前(VRMの表情名)。番号はこの並び順で固定する */
export const EXPRESSION_NAMES = [
  'blinkLeft',
  'blinkRight',
  'aa',
  'ih',
  'ou',
  'ee',
  'oh',
  'happy',
  'surprised',
] as const;

export type ExpressionName = (typeof EXPRESSION_NAMES)[number];

/**
 * ブレンドシェイプ(ARKit系の52種)から、VRMの表情へ。
 * 目を開けていても値が少し残る・口を少し開けただけで反応しすぎる、を避けるため
 * 下限と上限で引き直す。笑顔・驚きは誤反応すると目立つので弱めにしてある。
 * 口は、マイクを入れていれば視聴側のリップシンク(音声解析)が上書きする
 */
export function expressionsFromBlendshapes(
  shapes: ReadonlyMap<string, number>,
): Record<ExpressionName, number> {
  const get = (name: string) => shapes.get(name) ?? 0;
  const avg = (a: string, b: string) => (get(a) + get(b)) / 2;
  const smile = remap(avg('mouthSmileLeft', 'mouthSmileRight'), 0.35, 0.85);
  const jaw = remap(get('jawOpen'), 0.06, 0.55);
  const funnel = remap(get('mouthFunnel'), 0.12, 0.5);
  const pucker = remap(get('mouthPucker'), 0.25, 0.75);
  const stretch = remap(avg('mouthStretchLeft', 'mouthStretchRight'), 0.12, 0.5);
  return {
    blinkLeft: remap(get('eyeBlinkLeft'), 0.35, 0.75),
    blinkRight: remap(get('eyeBlinkRight'), 0.35, 0.75),
    // 口の開きを「あ」に、すぼめ・突き出し・横引きでほかの母音へ振り分ける
    aa: jaw * (1 - Math.max(funnel, pucker) * 0.7),
    ih: stretch * 0.5 * (1 - jaw),
    ou: pucker,
    ee: stretch * (1 - pucker),
    oh: funnel * jaw,
    happy: smile * 0.7,
    surprised:
      remap(get('browInnerUp'), 0.45, 0.9) *
      remap(avg('eyeWideLeft', 'eyeWideRight'), 0.2, 0.6) *
      0.6,
  };
}

const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _indexDir = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _points = Array.from({ length: 5 }, () => new THREE.Vector3());
