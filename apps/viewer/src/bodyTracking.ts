/**
 * ボディトラッキング(WebXR Body Tracking。Quest Browser の実験機能)から、ワイヤの体セクションを作る。
 *
 * 向きは**関節の位置だけから組み立てる**。仕様は手首・手のひら以外の関節の軸を定めておらず、
 * 実装ごとに違いうるため(Babylon.js も軸の補正オプションを持っている)。
 * 腰は左右の股関節を結ぶ線と背骨、胸は両肩を結ぶ線と首、足は足首→つま先の水平方向で決める。
 *
 * 脚は Quest では実測でなく上半身からの推定(仕様上、取れない関節は推定で埋めることになっている)
 */
import * as THREE from 'three';
import type { BodySection, PoseNode, Quat, Vec3 } from '@xroomcast/protocol';

// ボディトラッキングは @types/webxr に無いので、使う分だけ定義する
type BodyJoint =
  | 'hips'
  | 'spine-middle'
  | 'chest'
  | 'neck'
  | 'left-arm-upper'
  | 'right-arm-upper'
  | 'left-upper-leg'
  | 'right-upper-leg'
  | 'left-lower-leg'
  | 'right-lower-leg'
  | 'left-foot-ankle'
  | 'right-foot-ankle'
  | 'left-foot-ball'
  | 'right-foot-ball';
interface XRBodyLike {
  get(joint: BodyJoint): XRSpace | undefined;
}
export type BodyFrame = XRFrame & { body?: XRBodyLike | null };

const JOINTS: readonly BodyJoint[] = [
  'hips',
  'spine-middle',
  'chest',
  'neck',
  'left-arm-upper',
  'right-arm-upper',
  'left-upper-leg',
  'right-upper-leg',
  'left-lower-leg',
  'right-lower-leg',
  'left-foot-ankle',
  'right-foot-ankle',
  'left-foot-ball',
  'right-foot-ball',
];

const UP = new THREE.Vector3(0, 1, 0);
const _x = new THREE.Vector3();
const _y = new THREE.Vector3();
const _z = new THREE.Vector3();
const _basis = new THREE.Matrix4();
const _q = new THREE.Quaternion();

/**
 * 「左向き(+X)」と「上向き(+Y)」の目安から、Tポーズのレスト(正面+Z)に対する回転を作る。
 * VRMのレストは左=+X・上=+Y・正面=+Zなので、直立して正面を向いていれば単位元になる
 */
function rotationFrom(left: THREE.Vector3, up: THREE.Vector3): Quat | null {
  _x.copy(left);
  _z.crossVectors(_x, up);
  if (_x.lengthSq() < 1e-8 || _z.lengthSq() < 1e-8) return null;
  _x.normalize();
  _z.normalize();
  _y.crossVectors(_z, _x);
  _q.setFromRotationMatrix(_basis.makeBasis(_x, _y, _z));
  return [_q.x, _q.y, _q.z, _q.w];
}

/** 足は水平の向き(ヨー)だけにする。足首はつま先より高いので、そのまま使うと常に前傾してしまう */
function footRotation(ankle: THREE.Vector3, ball: THREE.Vector3): Quat | null {
  _z.subVectors(ball, ankle);
  _z.y = 0;
  if (_z.lengthSq() < 1e-6) return null;
  _x.crossVectors(UP, _z);
  return rotationFrom(_x, UP);
}

const toVec3 = (v: THREE.Vector3): Vec3 => [v.x, v.y, v.z];

/**
 * 体を読む。仕様上「全身が取れるか、まったく取れないか」なので、1関節でも欠けたら null。
 * @param toWire XR空間の位置を、ワイヤ座標(キャリブレーション済み)へ変換する
 */
export function readBody(
  frame: BodyFrame,
  refSpace: XRReferenceSpace,
  toWire: (p: DOMPointReadOnly, out: THREE.Vector3) => THREE.Vector3,
): BodySection | null {
  const body = frame.body;
  if (!body) return null;
  const p = {} as Record<BodyJoint, THREE.Vector3>;
  for (const joint of JOINTS) {
    const space = body.get(joint);
    const pose = space ? frame.getPose(space, refSpace) : undefined;
    if (!pose) return null;
    p[joint] = toWire(pose.transform.position, new THREE.Vector3());
  }

  const hipsRotation = rotationFrom(
    new THREE.Vector3().subVectors(p['left-upper-leg'], p['right-upper-leg']),
    new THREE.Vector3().subVectors(p['spine-middle'], p.hips),
  );
  const chest = rotationFrom(
    new THREE.Vector3().subVectors(p['left-arm-upper'], p['right-arm-upper']),
    new THREE.Vector3().subVectors(p.neck, p.chest),
  );
  const leftFoot = footRotation(p['left-foot-ankle'], p['left-foot-ball']);
  const rightFoot = footRotation(p['right-foot-ankle'], p['right-foot-ball']);
  if (!hipsRotation || !chest || !leftFoot || !rightFoot) return null;

  const node = (position: THREE.Vector3, rotation: Quat): PoseNode => ({
    position: toVec3(position),
    rotation,
  });
  return {
    hips: node(p.hips, hipsRotation),
    chest,
    leftFoot: node(p['left-foot-ankle'], leftFoot),
    rightFoot: node(p['right-foot-ankle'], rightFoot),
    leftKnee: toVec3(p['left-lower-leg']),
    rightKnee: toVec3(p['right-lower-leg']),
  };
}
