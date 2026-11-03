/**
 * 受信フレームをVRMへ適用するパイプライン(実装仕様書 §5 Phase 2a パイプライン2〜5)。
 * - 頭: 回転をheadボーンへ、頭位置の差分でhipsを平行移動(ルートモーション)
 * - 手: 手首位置・回転を目標に2ボーンIK。肘のポールは「体側やや後方・下方」固定
 * - 体の向き(体が送られてこないとき): 頭の向きに遅れて追従させる。頭と体のずれが一定を超えたら体を回し、
 *   足は向きや位置が大きくずれたら踏み替える(VRChat の元になっている VRIK と同じ考え方)
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
/**
 * 親指を曲げたときに、ほかの指の側へ寄せる角度(rad、付け根の関節)。
 * 手のひら側へ曲げるだけだと、グーやピースで親指が前へ突き出て「開いた」ように見える。
 * 実際の親指も、曲げると人差し指・中指の方へ寄っていく
 */
const THUMB_ADDUCT_MAX = 0.7;
/**
 * スプレッド(指の開き)。0.5が自然位置で、1で開き切る・0で閉じ切る。
 * 開く側は人差し指と小指の間が最大約46°(パーで指の間に隙間ができ、ピースがV字に見える)。
 * 閉じる側を同じだけ動かすと指どうしが重なるので、小さくしてある。
 * 中指は動かさず、人差し指を大きく外へ振る(ピースで人差し指と中指の間が開くように)
 */
const SPREAD_OPEN_MAX = 0.4;
const SPREAD_CLOSE_MAX = 0.15;
const SPREAD_FACTORS = [1, 0, -0.5, -1] as const;
/**
 * 手首のひねりのうち前腕に分け持たせる割合。手首だけでひねると手首のメッシュが細く絞られるため
 * (実際の前腕も肘から手首にかけてひねりを分け持つ)。twoBoneIK.ts の twistShare
 */
const FOREARM_TWIST_SHARE = 0.5;

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
const _feetMid = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _yawQuat = new THREE.Quaternion();
const _feetYawQuat = new THREE.Quaternion();
const _hipsLocal = new THREE.Vector3();

/** -π..π に収める */
function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}
/** 脚の長さの比の範囲。トラッキングの乱れで極端な値にならないよう抑える */
const LEG_SCALE_MIN = 0.6;
const LEG_SCALE_MAX = 1.6;
/** 脚の長さの比を毎フレーム寄せる割合(トラッキングの揺れを均す) */
const LEG_SCALE_SMOOTHING = 0.05;
/** 膝のポールを体の前方へ寄せる距離(m)。脚が伸びきると膝が股と足首の線上に乗り、向きが決まらないため */
const KNEE_FORWARD_BIAS = 0.3;
/**
 * 体の向きの追従(体が送られてこないとき)。頭と体の向きのずれがこれを超えたら、超えたぶん体を回す。
 * 首を少し振る程度では体は回らず、大きく振り向いたり旋回したりすると体ごと向きを変える
 * (以前は体が常に正面のままで、旋回を重ねると首から上だけが回ってねじ切れて見えた)
 */
const BODY_YAW_DEADZONE = (40 * Math.PI) / 180;
/** ずれが範囲内でも、体を頭の向きへ少しずつ寄せる割合(1フレームあたり) */
const BODY_YAW_FOLLOW = 0.02;
/** 足を踏み替える、体と足の向きのずれ(rad)と、腰と足の真ん中の水平のずれ(m、ワイヤ座標) */
const STEP_ANGLE = (30 * Math.PI) / 180;
const STEP_DISTANCE = 0.35;
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
  /**
   * アバターの脚の長さ(股→膝→足首、リグ単位)。体を当てるとき、配信者の脚との比で
   * 腰の高さを合わせる。0 は脚が取れないモデル
   */
  private readonly restLegLength: number;
  /** 配信者の脚に対するアバターの脚の長さの比(均したもの)。null は未計測 */
  private legScale: number | null = null;
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
  /** 体の向き(ワイヤ座標の水平の角度、+Z が0)。頭の向きに遅れて追従する */
  private bodyYaw = 0;
  /** 足を置いている向きと、両足の真ん中(フレームローカルの水平位置) */
  private feetYaw = 0;
  private readonly feetCenter = new THREE.Vector3();
  /** レストの両足の真ん中(フレームローカル) */
  private readonly restFeetCenter = new THREE.Vector3();
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
    if (this.footAnchors.left && this.footAnchors.right) {
      this.restFeetCenter.addVectors(this.footAnchors.left, this.footAnchors.right).multiplyScalar(0.5);
      this.restFeetCenter.y = 0;
    }
    this.feetCenter.copy(this.restFeetCenter);
    // 正規化リグのレストは回転が単位元なので、ローカルの位置を足すだけで腰からの距離になる
    const legLength = (chain: TwoBoneChain | null): number | null =>
      chain
        ? _a.copy(chain.upper.position).add(chain.lower.position).length() + chain.lowerLen
        : null;
    const legs = [legLength(this.legChains.left), legLength(this.legChains.right)].filter(
      (v): v is number => v !== null,
    );
    this.restLegLength = legs.length > 0 ? legs.reduce((s, v) => s + v, 0) / legs.length : 0;

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
      solveTwoBoneIK(chain, _handTarget, _handQuat, _pole, FOREARM_TWIST_SHARE);
    }
  }

  /**
   * 体がある場合。回転はすべてワールド系の意味(レスト差分)で届くので、
   * 親の回転を外してから各ボーンのローカル回転にする
   */
  private applyBody(pose: PoseSection, body: BodySection, scale: number): void {
    this.bodyApplied = true;
    this.updateLegScale(body);
    _hipsQuat.fromArray(body.hips.rotation);
    _chestQuat.fromArray(body.chest);

    if (this.hips) {
      this.toRigLocal(this.hips.quaternion.copy(_hipsQuat));
      // 腰の位置は親の系へ直接置く(頭からの推定は使わない)
      const parent = this.hips.parent;
      this.toAvatarLegs(_hipsTarget.fromArray(body.hips.position), body);
      _hipsTarget.applyMatrix4(this.frame.matrixWorld);
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
      this.toAvatarLegs(_pole.fromArray(side === 'left' ? body.leftKnee : body.rightKnee), body)
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

    // 体の向き: 頭の向き(水平成分)に遅れて追従させる
    _headQuat.fromArray(pose.head.rotation);
    _a.set(0, 0, 1).applyQuaternion(_headQuat);
    if (_a.x * _a.x + _a.z * _a.z > 0.04) {
      const headYaw = Math.atan2(_a.x, _a.z);
      const gap = wrapAngle(headYaw - this.bodyYaw);
      if (Math.abs(gap) > BODY_YAW_DEADZONE) {
        this.bodyYaw += gap - Math.sign(gap) * BODY_YAW_DEADZONE;
      }
      this.bodyYaw = wrapAngle(this.bodyYaw + wrapAngle(headYaw - this.bodyYaw) * BODY_YAW_FOLLOW);
    }
    _yawQuat.setFromAxisAngle(Y_AXIS, this.bodyYaw);
    if (this.hips) {
      this.toRigLocal(this.hips.quaternion.copy(_yawQuat));
      // 腰を回したので、頭の位置を測り直す前に姿勢を確定させる
      this.hips.updateWorldMatrix(true, true);
    }

    // 頭: ワイヤ回転は「レストからの差分(ワールド系)」。腰で回したぶんを外して首から先のローカルにする。
    // リグ固有回転の共役変換はフレーム非依存
    if (this.head) {
      this.toRigLocal(this.head.quaternion.copy(_yawQuat).invert().multiply(_headQuat));
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

    // 足を踏み替える: 体の向きが足の向きから大きくずれたか、腰が足の真ん中から離れたら、
    // 腰の真下に、体の向きで足を置き直す(足踏みして向きを変える・歩く)
    if (this.hips) {
      this.frame.worldToLocal(this.hips.getWorldPosition(_hipsLocal));
      _hipsLocal.y = 0;
      const turned = Math.abs(wrapAngle(this.bodyYaw - this.feetYaw)) > STEP_ANGLE;
      const moved = _hipsLocal.distanceTo(this.feetCenter) > STEP_DISTANCE;
      if (turned || moved) {
        this.feetYaw = this.bodyYaw;
        this.feetCenter.copy(_hipsLocal);
      }
    }
    _feetYawQuat.setFromAxisAngle(Y_AXIS, this.feetYaw);

    // 足: 接地固定IK。レストの足首の位置を、足を置いている向き・位置へ回して移し、ワールドへ変換して固定する
    for (const side of ['left', 'right'] as const) {
      const chain = this.legChains[side];
      const anchor = this.footAnchors[side];
      if (!chain || !anchor) continue;
      _anchorWorld
        .copy(anchor)
        .sub(this.restFeetCenter)
        .applyQuaternion(_feetYawQuat)
        .add(this.feetCenter)
        .applyMatrix4(this.frame.matrixWorld);
      _footQuat.copy(_frameQuat).multiply(_feetYawQuat).multiply(this.rootQuat);
      chain.upper.getWorldPosition(_pole);
      _poleOffset
        .set(0, -0.4, 0.6)
        .applyQuaternion(_yawQuat)
        .applyQuaternion(_frameQuat)
        .multiplyScalar(scale);
      _pole.add(_poleOffset); // 膝は体の前方へ曲げる
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
            // 付け根では、曲げるほど指の側(左手は+X、右手は-X)へ寄せる。
            // Y軸回りの正の回転は +Z(親指)を +X へ回すので、左手は正・右手は負
            if (j === 0) {
              const adductSign = side === 'left' ? 1 : -1;
              _spreadQuat.setFromAxisAngle(Y_AXIS, adductSign * THUMB_ADDUCT_MAX * curl);
              joint.quaternion.premultiply(_spreadQuat);
            }
          } else {
            joint.quaternion.setFromAxisAngle(Z_AXIS, curlSign * maxAngles[j]! * curl);
            // スプレッド: 付け根関節のY軸回りで扇状に開く(0.5が自然位置)
            if (j === 0) {
              const factor = SPREAD_FACTORS[fingerIndex - 1]!;
              // 開く(spread > 0.5)と人差し指が親指側(+Z)へ、小指が反対側へ振れる向き。
              // Y軸回りの正の回転は、左手の指先(+X)を -Z へ、右手の指先(-X)を +Z へ回すので、
              // 左手は負・右手は正にする(以前は逆で、開くほど人差し指が中指に重なっていた)
              const spreadSign = side === 'left' ? -1 : 1;
              const amount = (spread - 0.5) * 2 * (spread > 0.5 ? SPREAD_OPEN_MAX : SPREAD_CLOSE_MAX);
              _spreadQuat.setFromAxisAngle(Y_AXIS, spreadSign * factor * amount);
              joint.quaternion.premultiply(_spreadQuat);
            }
          }
          this.toRigLocal(joint.quaternion);
        }
      }
    }
  }

  /** デモ停止時などにレスト(Tポーズ・無表情)へ戻す */
  /**
   * 配信者とアバターで脚の長さの割合が違っても、膝が曲がりっぱなし・足が浮きっぱなしにならないよう、
   * 両足首の中点から見た位置(ワイヤ座標、in place)を脚の長さの比で伸び縮みさせる。
   *
   * 送信側は身長(目の高さ)全体の比で合わせているが、脚と胴の割合はアバターごとに違う
   * (脚の長いアバターだと腰が低すぎて膝が曲がり、短いアバターだと腰が高すぎて足が届かない)。
   * 足首の中点を中心に拡大縮小すると、脚の形(膝の角度)を保ったまま腰の高さが合う
   */
  private toAvatarLegs(position: THREE.Vector3, body: BodySection): THREE.Vector3 {
    const k = this.legScale;
    if (k === null || k === 1) return position;
    _feetMid
      .fromArray(body.leftFoot.position)
      .add(_a.fromArray(body.rightFoot.position))
      .multiplyScalar(0.5);
    return position.sub(_feetMid).multiplyScalar(k).add(_feetMid);
  }

  /** 配信者の脚の長さ(腰→膝→足首)を測り、アバターの脚との比を更新する */
  private updateLegScale(body: BodySection): void {
    if (this.restLegLength <= 0) return;
    let total = 0;
    for (const [knee, foot] of [
      [body.leftKnee, body.leftFoot.position],
      [body.rightKnee, body.rightFoot.position],
    ] as const) {
      _a.fromArray(knee);
      total += _b.fromArray(body.hips.position).distanceTo(_a) + _a.distanceTo(_b.fromArray(foot));
    }
    const streamed = total / 2;
    if (streamed < 0.2) return; // 脚が取れていない(推定が潰れている)
    const target = THREE.MathUtils.clamp(
      this.restLegLength / streamed,
      LEG_SCALE_MIN,
      LEG_SCALE_MAX,
    );
    this.legScale =
      this.legScale === null
        ? target
        : this.legScale + (target - this.legScale) * LEG_SCALE_SMOOTHING;
  }

  reset(): void {
    this.legScale = null;
    this.bodyYaw = 0;
    this.feetYaw = 0;
    this.feetCenter.copy(this.restFeetCenter);
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
