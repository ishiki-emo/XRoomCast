/**
 * 受信フレームをVRMへ適用するパイプライン(実装仕様書 §5 Phase 2a パイプライン2〜5)。
 * - 頭: 回転をheadボーンへ、頭位置の差分でhipsを平行移動(ルートモーション)
 * - 手: 手首位置・回転を目標に2ボーンIK。肘のポールは「体側やや後方・下方」固定
 * - 表情: expressionManagerへ適用
 * - 手指: カール値を各指3関節の回転に展開(カール1.0で握り込み)
 * three-vrmの正規化ボーン(レスト=Tポーズ、正面+Z、左=+X)に対して適用する。
 */
import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { FingerSection, PoseSection } from '@vrmsync/protocol';
import type { SampledFrame } from './poseStream';
import { createTwoBoneChain, solveTwoBoneIK, type TwoBoneChain } from './twoBoneIK';

type Side = 'left' | 'right';
const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const THUMB_SEGMENTS = ['Metacarpal', 'Proximal', 'Distal'] as const;
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;

/** 関節ごとの最大屈曲角(rad)。カール1.0でこの角度まで曲がる */
const CURL_MAX = [1.2, 1.4, 1.0] as const;
const THUMB_CURL_MAX = [0.4, 0.6, 0.6] as const;
/** スプレッド(指の開き)の最大角と指ごとの係数(人差し指→小指) */
const SPREAD_MAX = 0.25;
const SPREAD_FACTORS = [1, 0.35, -0.35, -1] as const;

const _headWorld = new THREE.Vector3();
const _headTarget = new THREE.Vector3();
const _handTarget = new THREE.Vector3();
const _handQuat = new THREE.Quaternion();
const _pole = new THREE.Vector3();
const _spreadQuat = new THREE.Quaternion();
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class PoseApplier {
  private readonly vrm: VRM;
  private readonly hips: THREE.Object3D | null;
  private readonly head: THREE.Object3D | null;
  private readonly restHipsPos = new THREE.Vector3();
  /**
   * 正規化リグのワールド回転。VRM 0.xでは VRMUtils.rotateVRM0 による
   * Y軸180°回転が vrm.scene に乗るため、ワールド系のワイヤ値を
   * リグのローカル系へ変換する際に必ずこれを挟む必要がある
   */
  private readonly rootQuat = new THREE.Quaternion();
  private readonly rootQuatInv = new THREE.Quaternion();
  private readonly armChains: Record<Side, TwoBoneChain | null>;
  private readonly legChains: Record<Side, TwoBoneChain | null>;
  /** レスト時の足首ワールド位置。ここに足を固定して接地させる */
  private readonly footAnchors: Record<Side, THREE.Vector3 | null>;
  private readonly fingerJoints: Record<Side, (THREE.Object3D | null)[][]>;
  private readonly touchedExpressions = new Set<string>();

  constructor(vrm: VRM) {
    this.vrm = vrm;
    const humanoid = vrm.humanoid;
    const bone = (name: VRMHumanBoneName) => humanoid.getNormalizedBoneNode(name);

    this.hips = bone('hips');
    this.head = bone('head');
    if (this.hips) {
      this.restHipsPos.copy(this.hips.position);
      this.hips.parent?.getWorldQuaternion(this.rootQuat);
    }
    this.rootQuatInv.copy(this.rootQuat).invert();

    this.armChains = {
      left: createTwoBoneChain(bone('leftUpperArm'), bone('leftLowerArm'), bone('leftHand')),
      right: createTwoBoneChain(bone('rightUpperArm'), bone('rightLowerArm'), bone('rightHand')),
    };
    this.legChains = {
      left: createTwoBoneChain(bone('leftUpperLeg'), bone('leftLowerLeg'), bone('leftFoot')),
      right: createTwoBoneChain(bone('rightUpperLeg'), bone('rightLowerLeg'), bone('rightFoot')),
    };
    this.footAnchors = {
      left: this.legChains.left?.end.getWorldPosition(new THREE.Vector3()) ?? null,
      right: this.legChains.right?.end.getWorldPosition(new THREE.Vector3()) ?? null,
    };

    const jointsFor = (side: Side) =>
      FINGERS.map((finger, fingerIndex) => {
        const segments = fingerIndex === 0 ? THUMB_SEGMENTS : FINGER_SEGMENTS;
        return segments.map((seg) => bone(`${side}${finger}${seg}` as VRMHumanBoneName));
      });
    this.fingerJoints = { left: jointsFor('left'), right: jointsFor('right') };
  }

  apply(frame: SampledFrame): void {
    if (frame.pose) this.applyPose(frame.pose);
    if (frame.expressions) this.applyExpressions(frame.expressions);
    if (frame.fingers) this.applyFingers(frame.fingers);
  }

  /**
   * ワールド系の意味で作った回転を、リグローカル系の回転へ共役変換する(in place)。
   * VRM 1.0ではrootQuatが単位元なので恒等変換になる
   */
  private toRigLocal(q: THREE.Quaternion): THREE.Quaternion {
    return q.premultiply(this.rootQuatInv).multiply(this.rootQuat);
  }

  private applyPose(pose: PoseSection): void {
    // 頭: ワイヤ回転はワールド系での「レストからの差分」。
    // リグのワールド回転を挟んでローカル回転へ変換する(首より上は無回転なので親=ルート系)
    if (this.head) {
      this.toRigLocal(this.head.quaternion.fromArray(pose.head.rotation));
    }

    // ルートモーション: 受信した頭位置と現在の頭位置のワールド差分でhipsを平行移動。
    // 差分はhipsの親のローカル系に変換してから加算する
    if (this.hips && this.head) {
      this.head.getWorldPosition(_headWorld);
      _headTarget.fromArray(pose.head.position);
      this.hips.position.add(_headTarget.sub(_headWorld).applyQuaternion(this.rootQuatInv));
    }

    // 足: 接地固定IK。hipsのルートモーションに合わせて膝で吸収し、
    // 足首をレスト時のワールド位置・向きに留める(足滑り防止)
    for (const side of ['left', 'right'] as const) {
      const chain = this.legChains[side];
      const anchor = this.footAnchors[side];
      if (!chain || !anchor) continue;
      chain.upper.getWorldPosition(_pole);
      _pole.y -= 0.4;
      _pole.z += 0.6; // 膝は前方(+Z)へ曲げる
      solveTwoBoneIK(chain, anchor, this.rootQuat, _pole);
    }

    // 手: 2ボーンIK。肘のポールは肩から見て「体側やや後方・下方」の固定ヒューリスティック
    for (const side of ['left', 'right'] as const) {
      const chain = this.armChains[side];
      if (!chain) continue;
      const node = side === 'left' ? pose.leftHand : pose.rightHand;
      _handTarget.fromArray(node.position);
      // ワイヤ回転(レストからのワールド系差分)× レスト時のワールド回転 = 目標ワールド回転
      _handQuat.fromArray(node.rotation).multiply(this.rootQuat);
      chain.upper.getWorldPosition(_pole);
      _pole.x += side === 'left' ? 0.15 : -0.15;
      _pole.y -= 0.6;
      _pole.z -= 0.35;
      solveTwoBoneIK(chain, _handTarget, _handQuat, _pole);
    }
  }

  private applyExpressions(expressions: ReadonlyMap<string, number>): void {
    const manager = this.vrm.expressionManager;
    if (!manager) return;
    for (const [name, value] of expressions) {
      if (manager.getExpression(name)) {
        manager.setValue(name, value);
        this.touchedExpressions.add(name);
      }
    }
  }

  private applyFingers(fingers: FingerSection): void {
    for (const side of ['left', 'right'] as const) {
      const curls = side === 'left' ? fingers.leftCurls : fingers.rightCurls;
      const spread = side === 'left' ? fingers.leftSpread : fingers.rightSpread;
      // Tポーズで指は左=+X/右=−X、手のひらは下(−Y)。曲げはZ軸回りの回転になる
      const curlSign = side === 'left' ? -1 : 1;

      for (let fingerIndex = 0; fingerIndex < FINGERS.length; fingerIndex++) {
        const joints = this.fingerJoints[side][fingerIndex]!;
        const curl = curls[fingerIndex]!;
        const isThumb = fingerIndex === 0;
        const maxAngles = isThumb ? THUMB_CURL_MAX : CURL_MAX;

        for (let j = 0; j < joints.length; j++) {
          const joint = joints[j];
          if (!joint) continue;
          // 回転はワールド系の意味(左指=+X、手のひら=−Y、親指=+Z前提)で作り、
          // 最後にリグローカル系へ共役変換する
          if (isThumb) {
            // 親指は前(+Z)向きなのでX軸回りで手のひら側へ曲げる
            joint.quaternion.setFromAxisAngle(X_AXIS, maxAngles[j]! * curl);
          } else {
            joint.quaternion.setFromAxisAngle(Z_AXIS, curlSign * maxAngles[j]! * curl);
            // スプレッド: 付け根関節のY軸回りで扇状に開く(0.5が自然位置)
            if (j === 0) {
              const factor = SPREAD_FACTORS[fingerIndex - 1]!;
              const spreadSign = side === 'left' ? 1 : -1;
              _spreadQuat.setFromAxisAngle(Y_AXIS, spreadSign * factor * (spread - 0.5) * SPREAD_MAX);
              joint.quaternion.premultiply(_spreadQuat);
            }
          }
          this.toRigLocal(joint.quaternion);
        }
      }
    }
  }

  /** デモ停止時などにレスト(Tポーズ・無表情)へ戻す */
  reset(): void {
    if (this.head) this.head.quaternion.identity();
    if (this.hips) this.hips.position.copy(this.restHipsPos);
    for (const side of ['left', 'right'] as const) {
      for (const chain of [this.armChains[side], this.legChains[side]]) {
        if (chain) {
          chain.upper.quaternion.identity();
          chain.lower.quaternion.identity();
          chain.end.quaternion.identity();
        }
      }
      for (const joints of this.fingerJoints[side]) {
        for (const joint of joints) joint?.quaternion.identity();
      }
    }
    const manager = this.vrm.expressionManager;
    if (manager) {
      for (const name of this.touchedExpressions) manager.setValue(name, 0);
    }
    this.touchedExpressions.clear();
  }
}
