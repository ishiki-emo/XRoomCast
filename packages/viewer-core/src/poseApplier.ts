/**
 * 受信フレームをVRMへ適用するパイプライン(実装仕様書 §5 Phase 2a パイプライン2〜5)。
 * - 頭: 回転をheadボーンへ、頭位置の差分でhipsを平行移動(ルートモーション)
 * - 手: 手首位置・回転を目標に2ボーンIK。肘のポールは「体側やや後方・下方」固定
 * - 表情: expressionManagerへ適用
 * - 手指: カール値を各指3関節の回転に展開(カール1.0で握り込み)
 * - 体(ボディトラッキングの送信側だけ): 腰の位置・回転、胸の回転、足首目標と膝で足のIK。
 *   無いときは頭から腰を推定し、足は接地固定にする
 * three-vrmの正規化ボーン(レスト=Tポーズ、正面+Z、左=+X)に対して適用する。
 */
import * as THREE from 'three';
import type { VRM, VRMHumanBoneName } from '@pixiv/three-vrm';
import type { BodySection, FingerSection, PoseSection } from '@xroomcast/protocol';
import type { SampledFrame } from '@xroomcast/sync';
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
const _poleOffset = new THREE.Vector3();
const _anchorWorld = new THREE.Vector3();
const _footQuat = new THREE.Quaternion();
const _framePos = new THREE.Vector3();
const _frameQuat = new THREE.Quaternion();
const _frameQuatInv = new THREE.Quaternion();
const _frameScale = new THREE.Vector3();
const _spreadQuat = new THREE.Quaternion();
const _hipsQuat = new THREE.Quaternion();
const _headQuat = new THREE.Quaternion();
const _identity = new THREE.Quaternion();
const _chestQuat = new THREE.Quaternion();
const _bendQuat = new THREE.Quaternion();
const _hipsTarget = new THREE.Vector3();
const _bodyForward = new THREE.Vector3();
/** 膝のポールを体の前方へ寄せる距離(m)。脚が伸びきると膝が股と足首の線上に乗り、向きが決まらないため */
const KNEE_FORWARD_BIAS = 0.3;
const Y_AXIS = new THREE.Vector3(0, 1, 0);
const X_AXIS = new THREE.Vector3(1, 0, 0);
const Z_AXIS = new THREE.Vector3(0, 0, 1);

export class PoseApplier {
  private readonly vrm: VRM;
  private readonly hips: THREE.Object3D | null;
  private readonly head: THREE.Object3D | null;
  private readonly spine: THREE.Object3D | null;
  private readonly chest: THREE.Object3D | null;
  /** 直前のフレームで体を適用したか。体が途切れたら腰・背骨の回転をレストへ戻す */
  private bodyApplied = false;
  private readonly restHipsPos = new THREE.Vector3();
  /**
   * 正規化リグのワールド回転。VRM 0.xでは VRMUtils.rotateVRM0 による
   * Y軸180°回転が vrm.scene に乗るため、ワールド系のワイヤ値を
   * リグのローカル系へ変換する際に必ずこれを挟む必要がある
   */
  private readonly rootQuat = new THREE.Quaternion();
  private readonly rootQuatInv = new THREE.Quaternion();
  /** 配置フレーム。ワイヤ座標はこのフレームのローカル系として解釈する */
  private readonly frame: THREE.Object3D;
  private readonly armChains: Record<Side, TwoBoneChain | null>;
  private readonly legChains: Record<Side, TwoBoneChain | null>;
  /** レスト時の足首ワールド位置。ここに足を固定して接地させる */
  private readonly footAnchors: Record<Side, THREE.Vector3 | null>;
  private readonly fingerJoints: Record<Side, (THREE.Object3D | null)[][]>;
  private readonly touchedExpressions = new Set<string>();

  /**
   * @param frame 配置フレーム(AR設置・卓上スケール用)。ワイヤ座標はこの
   *   フレームのローカル系として解釈される。省略時はワールド=フレーム
   */
  constructor(vrm: VRM, frame?: THREE.Object3D) {
    this.vrm = vrm;
    this.frame = frame ?? vrm.scene.parent ?? vrm.scene;
    const humanoid = vrm.humanoid;
    const bone = (name: VRMHumanBoneName) => humanoid.getNormalizedBoneNode(name);

    this.hips = bone('hips');
    this.head = bone('head');
    this.spine = bone('spine');
    this.chest = bone('chest');
    if (this.hips) {
      this.restHipsPos.copy(this.hips.position);
      // rootQuat はフレームを除いたリグ固有の回転(VRM0.xのπ回転)だけを持つ
      this.hips.parent?.getWorldQuaternion(this.rootQuat);
      this.frame.getWorldQuaternion(_frameQuat);
      this.rootQuat.premultiply(_frameQuat.invert());
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
    // 足首のレスト位置はフレームローカルで保持する(フレームの移動・スケールに追従)
    this.frame.updateWorldMatrix(true, false);
    const anchorLocal = (chain: TwoBoneChain | null): THREE.Vector3 | null =>
      chain ? this.frame.worldToLocal(chain.end.getWorldPosition(new THREE.Vector3())) : null;
    this.footAnchors = {
      left: anchorLocal(this.legChains.left),
      right: anchorLocal(this.legChains.right),
    };

    const jointsFor = (side: Side) =>
      FINGERS.map((finger, fingerIndex) => {
        const segments = fingerIndex === 0 ? THUMB_SEGMENTS : FINGER_SEGMENTS;
        return segments.map((seg) => bone(`${side}${finger}${seg}` as VRMHumanBoneName));
      });
    this.fingerJoints = { left: jointsFor('left'), right: jointsFor('right') };
  }

  apply(frame: SampledFrame): void {
    if (frame.pose) this.applyPose(frame.pose, frame.body);
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

  private applyPose(pose: PoseSection, body: BodySection | undefined): void {
    // 配置フレーム(AR設置・卓上スケール)を分解しておく。
    // ワイヤ座標は「フレームのローカル系(等身大)」として解釈し、都度ワールドへ変換する
    this.frame.updateWorldMatrix(true, false);
    this.frame.matrixWorld.decompose(_framePos, _frameQuat, _frameScale);
    const scale = _frameScale.x || 1;
    _frameQuatInv.copy(_frameQuat).invert();

    if (body) {
      this.applyBody(pose, body, scale);
    } else {
      this.applyHeadDriven(pose, scale);
    }

    // 手: 2ボーンIK。肘のポールは肩から見て「体側やや後方・下方」の固定ヒューリスティック
    for (const side of ['left', 'right'] as const) {
      const chain = this.armChains[side];
      if (!chain) continue;
      const node = side === 'left' ? pose.leftHand : pose.rightHand;
      _handTarget.fromArray(node.position).applyMatrix4(this.frame.matrixWorld);
      // フレーム回転 × ワイヤ回転(レスト差分)× リグ固有回転 = 目標ワールド回転
      _handQuat.fromArray(node.rotation).premultiply(_frameQuat).multiply(this.rootQuat);
      chain.upper.getWorldPosition(_pole);
      _poleOffset
        .set(side === 'left' ? 0.15 : -0.15, -0.6, -0.35)
        .applyQuaternion(_frameQuat)
        .multiplyScalar(scale);
      _pole.add(_poleOffset);
      solveTwoBoneIK(chain, _handTarget, _handQuat, _pole);
    }
  }

  /**
   * 体がある場合。回転はすべてワールド系の意味(レスト差分)で届くので、
   * 親の回転を外してから各ボーンのローカル回転にする
   */
  private applyBody(pose: PoseSection, body: BodySection, scale: number): void {
    this.bodyApplied = true;
    _hipsQuat.fromArray(body.hips.rotation);
    _chestQuat.fromArray(body.chest);

    if (this.hips) {
      this.toRigLocal(this.hips.quaternion.copy(_hipsQuat));
      // 腰の位置は親の系へ直接置く(頭からの推定は使わない)
      const parent = this.hips.parent;
      _hipsTarget.fromArray(body.hips.position).applyMatrix4(this.frame.matrixWorld);
      if (parent) {
        parent.updateWorldMatrix(true, false);
        parent.worldToLocal(_hipsTarget);
      }
      this.hips.position.copy(_hipsTarget);
    }

    // 胸の曲げ(腰に対する相対)を背骨と胸へ半分ずつ配る。胸ボーンが無いモデルは背骨だけで受ける
    _bendQuat.copy(_hipsQuat).invert().multiply(_chestQuat);
    if (this.spine && this.chest) _bendQuat.slerp(_identity, 0.5);
    if (this.spine) this.toRigLocal(this.spine.quaternion.copy(_bendQuat));
    if (this.chest) this.toRigLocal(this.chest.quaternion.copy(_bendQuat));

    // 頭はワールド系の向きで届くので、胸までの回転を外して首から先のローカルにする
    // (上胸・首はレストのまま)
    if (this.head) {
      this.toRigLocal(
        this.head.quaternion.copy(_chestQuat).invert().multiply(_headQuat.fromArray(pose.head.rotation)),
      );
    }

    // 足: 足首を目標に2ボーンIK。膝の位置をポールにし、体の前方へ少し寄せて伸びきりに備える
    _bodyForward.set(0, 0, 1).applyQuaternion(_hipsQuat).applyQuaternion(_frameQuat);
    for (const side of ['left', 'right'] as const) {
      const chain = this.legChains[side];
      if (!chain) continue;
      const foot = side === 'left' ? body.leftFoot : body.rightFoot;
      _anchorWorld.fromArray(foot.position).applyMatrix4(this.frame.matrixWorld);
      _footQuat.fromArray(foot.rotation).premultiply(_frameQuat).multiply(this.rootQuat);
      _pole
        .fromArray(side === 'left' ? body.leftKnee : body.rightKnee)
        .applyMatrix4(this.frame.matrixWorld)
        .addScaledVector(_bodyForward, KNEE_FORWARD_BIAS * scale);
      solveTwoBoneIK(chain, _anchorWorld, _footQuat, _pole);
    }
  }

  /** 体が無い場合(VMC・HMDの3点だけ)。頭から腰を動かし、足は接地固定 */
  private applyHeadDriven(pose: PoseSection, scale: number): void {
    if (this.bodyApplied) {
      // 体が途切れたら、体の経路でだけ回していたボーンをレストへ戻す
      this.bodyApplied = false;
      this.hips?.quaternion.identity();
      this.spine?.quaternion.identity();
      this.chest?.quaternion.identity();
    }

    // 頭: ワイヤ回転は「レストからの差分」。リグ固有回転の共役変換はフレーム非依存
    if (this.head) {
      this.toRigLocal(this.head.quaternion.fromArray(pose.head.rotation));
    }

    // ルートモーション: 頭位置のワールド差分でhipsを平行移動。
    // 差分は「フレーム→リグ」の順で回転を戻し、スケールで割ってリグ単位系へ
    if (this.hips && this.head) {
      this.head.getWorldPosition(_headWorld);
      _headTarget.fromArray(pose.head.position).applyMatrix4(this.frame.matrixWorld);
      this.hips.position.add(
        _headTarget
          .sub(_headWorld)
          .applyQuaternion(_frameQuatInv)
          .applyQuaternion(this.rootQuatInv)
          .divideScalar(scale),
      );
    }

    // 足: 接地固定IK。アンカー(フレームローカル)をワールドへ変換して固定する
    for (const side of ['left', 'right'] as const) {
      const chain = this.legChains[side];
      const anchor = this.footAnchors[side];
      if (!chain || !anchor) continue;
      _anchorWorld.copy(anchor).applyMatrix4(this.frame.matrixWorld);
      _footQuat.copy(_frameQuat).multiply(this.rootQuat);
      chain.upper.getWorldPosition(_pole);
      _poleOffset.set(0, -0.4, 0.6).applyQuaternion(_frameQuat).multiplyScalar(scale);
      _pole.add(_poleOffset); // 膝は前方(フレームの+Z)へ曲げる
      solveTwoBoneIK(chain, _anchorWorld, _footQuat, _pole);
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
    if (this.hips) {
      this.hips.position.copy(this.restHipsPos);
      this.hips.quaternion.identity();
    }
    this.spine?.quaternion.identity();
    this.chest?.quaternion.identity();
    this.bodyApplied = false;
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
