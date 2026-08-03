/**
 * クォータニオンの球面線形補間。
 *
 * three.js の `Quaternion.slerpFlat` の移植で、数値は同一
 * (test/quaternion.test.ts で three の実装と突き合わせている)。
 * 同期層が three に依存する箇所はここだけだったため、自前で持つことで
 * このパッケージを描画エンジン非依存にしている。Unity等の別クライアントや、
 * three を使わないサーバー側でもそのまま使える。
 */
import type { Quat } from '@xroomcast/protocol';

export function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  if (t === 0) return [a[0], a[1], a[2], a[3]];
  if (t === 1) return [b[0], b[1], b[2], b[3]];

  let [x0, y0, z0, w0] = a;
  const [x1, y1, z1, w1] = b;
  // 完全に同一なら補間の必要がない(0除算も避けられる)
  if (w0 === w1 && x0 === x1 && y0 === y1 && z0 === z1) return [x0, y0, z0, w0];

  let s = 1 - t;
  const cos = x0 * x1 + y0 * y1 + z0 * z1 + w0 * w1;
  // 最短経路を通るよう、鈍角なら片方を反転して扱う
  const dir = cos >= 0 ? 1 : -1;
  const sqrSin = 1 - cos * cos;

  // ほぼ同一の姿勢では sin が0に潰れるため、線形補間へフォールバックする
  if (sqrSin > Number.EPSILON) {
    const sin = Math.sqrt(sqrSin);
    const len = Math.atan2(sin, cos * dir);
    s = Math.sin(s * len) / sin;
    t = Math.sin(t * len) / sin;
  }

  const tDir = t * dir;
  x0 = x0 * s + x1 * tDir;
  y0 = y0 * s + y1 * tDir;
  z0 = z0 * s + z1 * tDir;
  w0 = w0 * s + w1 * tDir;

  // 線形補間になった場合は長さが1にならないので正規化する
  if (s === 1 - t) {
    const f = 1 / Math.sqrt(x0 * x0 + y0 * y0 + z0 * z0 + w0 * w0);
    x0 *= f;
    y0 *= f;
    z0 *= f;
    w0 *= f;
  }

  return [x0, y0, z0, w0];
}
