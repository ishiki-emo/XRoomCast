/**
 * ブリッジで使う最小限のベクトル/クォータニオン演算と、
 * Unity(左手系, Y-up, +Z前)→ Three.js(右手系, Y-up)の座標系変換(実装仕様書 §7)。
 * ワイヤ上のデータはThree.js系に統一する。変換は必ずブリッジ側で行う。
 */
import type { Quat, Vec3 } from '@xroomcast/protocol';

export const IDENTITY_QUAT: Quat = [0, 0, 0, 1];
export const ZERO_VEC3: Vec3 = [0, 0, 0];

export function quatMul(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a;
  const [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

export function rotateVec3(q: Quat, v: Vec3): Vec3 {
  // v' = q * v * q⁻¹
  const [qx, qy, qz, qw] = q;
  const [vx, vy, vz] = v;
  const tx = 2 * (qy * vz - qz * vy);
  const ty = 2 * (qz * vx - qx * vz);
  const tz = 2 * (qx * vy - qy * vx);
  return [
    vx + qw * tx + qy * tz - qz * ty,
    vy + qw * ty + qz * tx - qx * tz,
    vz + qw * tz + qx * ty - qy * tx,
  ];
}

export function addVec3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

/** Unity → Three.js: position (x, y, z) → (−x, y, z) */
export function unityToThreePos(p: Vec3): Vec3 {
  return [-p[0], p[1], p[2]];
}

/** Unity → Three.js: quaternion (x, y, z, w) → (x, −y, −z, w) */
export function unityToThreeQuat(q: Quat): Quat {
  return [q[0], -q[1], -q[2], q[3]];
}

/** クォータニオンの回転角(rad, 0..π)。指カールの見積もりに使う */
export function quatAngle(q: Quat): number {
  const w = Math.min(1, Math.abs(q[3]));
  return 2 * Math.acos(w);
}
