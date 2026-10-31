/**
 * ハンドトラッキング(WebXR Hand Input)から、ワイヤの手首と指を作る。
 *
 * ワイヤの指は「1本ごとの曲がり具合(0..1)+開き具合」しか持たないため、
 * 25関節の姿勢を送るのではなく、送信側で関節の折れ角から曲がり具合を見積もる。
 * ブリッジ(apps/bridge/src/skeleton.ts の fingerCurls)と同じ考え方で、
 * 満曲げの角度もそちらと揃えてある(視聴者側の poseApplier の上限角の合計)。
 */
import * as THREE from 'three';
import type { FingerCurls } from '@xroomcast/protocol';

/** 親指→小指の順。各指の付け根(metacarpal)から指先(tip)まで */
const FINGER_JOINTS: readonly (readonly XRHandJoint[])[] = [
  ['thumb-metacarpal', 'thumb-phalanx-proximal', 'thumb-phalanx-distal', 'thumb-tip'],
  ...(['index-finger', 'middle-finger', 'ring-finger', 'pinky-finger'] as const).map(
    (finger) =>
      [
        `${finger}-metacarpal`,
        `${finger}-phalanx-proximal`,
        `${finger}-phalanx-intermediate`,
        `${finger}-phalanx-distal`,
        `${finger}-tip`,
      ] as XRHandJoint[],
  ),
];

/** 満曲げとみなす折れ角の合計(rad)。poseApplier の CURL_MAX / THUMB_CURL_MAX の合計 */
const FULL_CURL_ANGLE = 3.6;
const THUMB_FULL_CURL_ANGLE = 1.6;
/**
 * 手を開いていても残る折れ角(rad)。これ以下は0として扱う。
 * 親指は開いても付け根で少し折れているため大きめ
 */
const REST_CURL_ANGLE = 0.15;
const THUMB_REST_CURL_ANGLE = 0.25;

/** 人差し指と小指の基節骨がなす角(rad)。自然に開いた手でこのくらい=スプレッド0.5 */
const REST_SPREAD_ANGLE = 0.35;
/** スプレッドを0→1動かすのに要る角度の幅(rad) */
const SPREAD_RANGE = 0.5;

/**
 * 前回値へ寄せる割合(0..1)。トラッキングの細かい震えを抑える。
 * 視聴者側は指を補間せず保持するだけなので、送信側でならしておく
 */
const SMOOTHING = 0.5;

/**
 * 手首関節の座標系を、ワイヤのTポーズの手へ合わせる補正。
 *
 * WebXRの関節空間: 指先方向=-Z、手のひらの外向き=-Y(手の甲=+Y)、
 * Xは右手系で決まる(右手は小指側、左手は親指側)
 * VRMのTポーズ: 指先=左は+X・右は-X、手のひら=-Y、親指=+Z
 *
 * コントローラ(gripToHand)と違って握りによる手首の傾きが乗らないので、
 * 手首オフセット(WRIST_OFFSET)は掛けない
 */
function wristToHand(side: 'left' | 'right'): THREE.Quaternion {
  const basis =
    side === 'left'
      ? // X(親指側)→+Z / Y(手の甲)→+Y / Z(指先の逆)→-X
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(-1, 0, 0),
        )
      : // X(小指側)→-Z / Y(手の甲)→+Y / Z(指先の逆)→+X
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 0, -1),
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(1, 0, 0),
        );
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

export const WRIST_TO_HAND: Record<'left' | 'right', THREE.Quaternion> = {
  left: wristToHand('left'),
  right: wristToHand('right'),
};

export interface HandReading {
  wrist: XRPose;
  curls: FingerCurls;
  spread: number;
}

const _points: THREE.Vector3[] = Array.from({ length: 5 }, () => new THREE.Vector3());
const _dirs: THREE.Vector3[] = Array.from({ length: 4 }, () => new THREE.Vector3());
const _indexDir = new THREE.Vector3();
const _pinkyDir = new THREE.Vector3();

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/** 左右それぞれの手を読む。前回値を持つのでセッション中は同じインスタンスを使う */
export class HandReader {
  private readonly previous: Record<'left' | 'right', { curls: FingerCurls; spread: number } | null> =
    { left: null, right: null };

  /** 関節が1つでも取れないフレーム(手が視界の外など)は null */
  read(
    frame: XRFrame,
    hand: XRHand,
    side: 'left' | 'right',
    refSpace: XRReferenceSpace,
  ): HandReading | null {
    const wristSpace = hand.get('wrist');
    const wrist = wristSpace ? frame.getJointPose?.(wristSpace, refSpace) : undefined;
    if (!wrist) return null;

    const curls = [0, 0, 0, 0, 0] as FingerCurls;
    for (let f = 0; f < FINGER_JOINTS.length; f++) {
      const joints = FINGER_JOINTS[f]!;
      for (let j = 0; j < joints.length; j++) {
        const space = hand.get(joints[j]!);
        const pose = space ? frame.getJointPose!(space, refSpace) : undefined;
        if (!pose) return null;
        const p = pose.transform.position;
        _points[j]!.set(p.x, p.y, p.z);
      }
      // 骨の向き(隣り合う関節の差)どうしの角度を足す=関節ごとの折れ角の合計
      for (let j = 0; j < joints.length - 1; j++) {
        _dirs[j]!.subVectors(_points[j + 1]!, _points[j]!);
      }
      let total = 0;
      for (let j = 0; j < joints.length - 2; j++) total += _dirs[j]!.angleTo(_dirs[j + 1]!);

      const isThumb = f === 0;
      const rest = isThumb ? THUMB_REST_CURL_ANGLE : REST_CURL_ANGLE;
      const full = isThumb ? THUMB_FULL_CURL_ANGLE : FULL_CURL_ANGLE;
      curls[f] = clamp01((total - rest) / (full - rest));

      // 基節骨(proximal → intermediate)の向きを、開き具合の計算用に取っておく
      if (f === 1) _indexDir.copy(_dirs[1]!);
      if (f === 4) _pinkyDir.copy(_dirs[1]!);
    }
    let spread = clamp01(0.5 + (_indexDir.angleTo(_pinkyDir) - REST_SPREAD_ANGLE) / SPREAD_RANGE);

    const prev = this.previous[side];
    if (prev) {
      for (let f = 0; f < 5; f++) curls[f] = curls[f]! + (prev.curls[f]! - curls[f]!) * SMOOTHING;
      spread += (prev.spread - spread) * SMOOTHING;
    }
    this.previous[side] = { curls, spread };
    return { wrist, curls, spread };
  }

  /** 手が見えなくなった・コントローラへ持ち替えたとき。次に見えたらならし直す */
  forget(side: 'left' | 'right'): void {
    this.previous[side] = null;
  }
}
