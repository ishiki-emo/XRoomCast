/**
 * HMDから直接配信する(VSeeFace・ブリッジなしでヘッドセット単体で配信)。
 *
 * ワイヤ形式が head / leftHand / rightHand の3ノードだけなので、HMDが持つ
 * 3点トラッキングとそのまま一致する。**送信側でIKを解く必要はない**
 * (視聴者側の PoseApplier + twoBoneIK が全身を解いている)。
 * ブリッジがVSeeFaceのフルボディを3点へ圧縮しているのと同じ位置づけ。
 *
 * 素手(ハンドトラッキング)のときは手首関節を手として使い、指の曲がり具合も
 * 関節から作って送る(handTracking.ts)。コントローラと素手は途中で持ち替えてよい。
 *
 * ボディトラッキングが使える端末(Quest)では、腰・胸・足も体セクションで送る
 * (bodyTracking.ts)。視聴者側は頭からの腰の推定をやめ、送られた体をそのまま使う。
 *
 * SFUへの接続と送信は posePublisher.ts(Webカメラ配信と共有)。
 */
import * as THREE from 'three';
import {
  type FingerCurls,
  type Packet,
  type PoseNode,
  type Quat,
  type Vec3,
} from '@xroomcast/protocol';
import type { AuthProvider } from '@xroomcast/sync';
import { readBody, type BodyFrame } from './bodyTracking';
import { HandReader, WRIST_TO_HAND } from './handTracking';
import { PosePublisher } from './posePublisher';

const SEND_INTERVAL_MS = 1000 / 30;
/** 指は2パケットに1回(15Hz)。ブリッジと同じ頻度で、視聴者側も保持で滑らかに見える */
const FINGER_EVERY = 2;

/**
 * 素手でないときの指。
 * 視聴者は最後に届いた指を保持し続けるため、素手からコントローラへ
 * 持ち替えたら必ず上書きする(しないと最後の手の形で固まる)
 */
const CONTROLLER_CURLS: FingerCurls = [0.3, 0.45, 0.5, 0.5, 0.5];
/** 手が取れず体側に下ろしているとき(待機モーションと同じ軽い曲げ) */
const RELAXED_CURLS: FingerCurls = [0.11, 0.16, 0.16, 0.16, 0.18];

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _forward = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);

/**
 * コントローラのグリップ座標系を、ワイヤのTポーズの手へ合わせる補正。
 *
 * WebXRのgrip space: 指先=-Z、親指側=+Y、右手系より手のひらの外向き=+X
 * VRMのTポーズ(poseApplier参照): 指先=左は+X・右は-X、手のひら=-Y、親指=+Z
 *
 * 3軸の対応から回転行列を直接組む(オイラー角で当てるとロールがずれる)。
 * makeBasis の引数は「元のX/Y/Z軸が、変換後にどこを向くか」
 */
function gripToHand(side: 'left' | 'right'): THREE.Quaternion {
  const basis =
    side === 'left'
      ? // X(手のひら外向き)→-Y / Y(親指)→+Z / Z(指先の逆)→-X
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, -1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(-1, 0, 0),
        )
      : new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(1, 0, 0),
        );
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

const GRIP_TO_HAND: Record<'left' | 'right', THREE.Quaternion> = {
  left: gripToHand('left'),
  right: gripToHand('right'),
};

/**
 * 手首の追加回転の既定値(度)。PICO 4 Ultra の実機で合わせた値。
 *
 * 軸の対応(gripToHand)だけでは合わないのは、コントローラを握ったときに
 * 手首が人間工学的に傾くぶんが乗るため。端末や持ち方で変わるので、
 * 配信者コンソールから調整でき、値はブラウザに保存される
 */
export const DEFAULT_WRIST_OFFSET = { x: 60, y: -30, z: -15 };

const WRIST_OFFSET: Record<'left' | 'right', THREE.Quaternion> = {
  left: new THREE.Quaternion(),
  right: new THREE.Quaternion(),
};

const _offsetEuler = new THREE.Euler();

/** 手首の追加回転を度で設定する(左右対称に適用。y/zは左右で符号を反転) */
export function setWristOffset(x: number, y: number, z: number): void {
  const rad = Math.PI / 180;
  WRIST_OFFSET.left.setFromEuler(_offsetEuler.set(x * rad, y * rad, z * rad));
  WRIST_OFFSET.right.setFromEuler(_offsetEuler.set(x * rad, -y * rad, -z * rad));
}

setWristOffset(DEFAULT_WRIST_OFFSET.x, DEFAULT_WRIST_OFFSET.y, DEFAULT_WRIST_OFFSET.z);

interface Calibration {
  /** 開始時の足元(水平位置。yは床) */
  origin: THREE.Vector3;
  /** 開始時の視線を+Zへ向ける回転(ワイヤはモデル正面が+Z) */
  yaw: THREE.Quaternion;
  /** yaw の角度(ワイヤ座標からXR空間へ戻すときに使う) */
  yawAngle: number;
  /** 開始時の頭の姿勢。ワイヤの回転は「レストからの差分」なのでこれを基準にする */
  headRest: THREE.Quaternion;
  /**
   * 配信者の身長をアバターの身長に合わせる倍率。
   * ワイヤの頭位置はそのままアバターの頭位置になるため、補正しないと
   * 背の高い人はアバターが伸び上がり、低い人はしゃがんだ姿勢になる
   */
  scale: number;
}

export class HmdBroadcast {
  onStatus: ((text: string, isError?: boolean) => void) | null = null;

  private readonly publisher: PosePublisher;
  private calibration: Calibration | null = null;
  private lastSentAt = 0;
  /** 表示中のアバターの頭の高さ(m)。身長補正に使う */
  private avatarHeight: number | null = null;
  private readonly handReader = new HandReader();

  /** アバターが切り替わったら教える(次のキャリブレーションから反映される) */
  setAvatarHeight(height: number): void {
    this.avatarHeight = height > 0.2 ? height : null;
  }

  /** 立ち位置と向きを取り直す(姿勢が崩れたときや、立ち位置を変えたとき) */
  recalibrate(): void {
    this.calibration = null;
  }

  constructor(
    room: string,
    auth: AuthProvider,
    /** 配信者名。席(slot)の割り当てとコンソールの自動席解決の鍵になる */
    pid: () => string = () => 'hmd',
  ) {
    this.publisher = new PosePublisher(room, auth, pid, (text) => this.onStatus?.(text));
  }

  get active(): boolean {
    return this.publisher.active;
  }

  /** SFUへパブリッシャーとして接続する */
  async connect(): Promise<void> {
    await this.publisher.connect();
    this.onStatus?.('HMDから配信中');
  }

  /**
   * 開始時の姿勢を基準にする。
   * 立っている位置を原点、そのとき向いている方向をアバターの正面とする
   */
  calibrate(viewer: XRViewerPose): void {
    const p = viewer.transform.position;
    const o = viewer.transform.orientation;
    _q.set(o.x, o.y, o.z, o.w);
    // 視線(-Z)の水平成分
    _forward.set(0, 0, -1).applyQuaternion(_q);
    _forward.y = 0;
    if (_forward.lengthSq() < 1e-6) _forward.set(0, 0, -1);
    _forward.normalize();

    // その方向を +Z へ回す(ワイヤはモデル正面が+Z)
    const yawAngle = Math.atan2(_forward.x, _forward.z);
    const yaw = new THREE.Quaternion().setFromAxisAngle(UP, -yawAngle);

    // 目の高さの比でアバターに合わせる(床からの高さがそのまま身長の目安になる)
    const eyeHeight = Math.max(p.y, 0.5);
    const scale = this.avatarHeight ? this.avatarHeight / eyeHeight : 1;

    this.calibration = {
      origin: new THREE.Vector3(p.x, 0, p.z), // 高さはlocal-floorの床(0)を使う
      yaw,
      yawAngle,
      headRest: new THREE.Quaternion().copy(yaw).multiply(_q),
      scale,
    };
    const note = this.avatarHeight
      ? `身長を${(scale * 100).toFixed(0)}%に合わせました`
      : '身長の補正なし';
    this.onStatus?.(`位置を合わせました(今の向きが正面 / ${note})`);
  }

  get calibrated(): boolean {
    return this.calibration !== null;
  }

  /**
   * ワイヤ座標(アバターのローカル)をXR空間へ戻すための変換。
   * 配信者にとってアバターは自分自身なので、これを使えば視聴者を
   * 「自分の周り」に置ける(手を伸ばせば届く位置関係になる)
   */
  getWireToXr(target: THREE.Object3D): boolean {
    if (!this.calibration) return false;
    target.position.copy(this.calibration.origin);
    target.quaternion.setFromAxisAngle(UP, this.calibration.yawAngle);
    return true;
  }

  /** XR空間の位置をワイヤ座標(足元が原点・正面+Z・身長補正済み)へ */
  private toWirePosition(p: DOMPointReadOnly, out: THREE.Vector3): THREE.Vector3 {
    const calibration = this.calibration!;
    return out
      .set(p.x, p.y, p.z)
      .sub(calibration.origin)
      .applyQuaternion(calibration.yaw)
      .multiplyScalar(calibration.scale);
  }

  private toNode(
    transform: XRRigidTransform,
    restInverse: THREE.Quaternion | null,
    extra?: THREE.Quaternion,
  ): PoseNode {
    const calibration = this.calibration!;
    const o = transform.orientation;
    this.toWirePosition(transform.position, _v);
    _q.set(o.x, o.y, o.z, o.w).premultiply(calibration.yaw);
    if (extra) _q.multiply(extra);
    // 差分はワールド系(ワイヤ座標)でとる: 現在 × 開始時の逆。受信側はワイヤ回転を
    // 「レストに左から掛けるワールド系の回転」として使うため。逆順(開始時の逆 × 現在)だと
    // 頭自身の系での差分になり、開始時の頭は正面+Zへ180°回っているので、うなずき・首かしげが反転する
    if (restInverse) _q.multiply(restInverse);
    return {
      position: [_v.x, _v.y, _v.z] as Vec3,
      rotation: [_q.x, _q.y, _q.z, _q.w] as Quat,
    };
  }

  /** XRのフレームごとに呼ぶ。30Hzに間引いて送信する */
  sendFrame(frame: XRFrame, refSpace: XRReferenceSpace, session: XRSession): void {
    if (!this.active || !this.calibration) return;
    const now = performance.now();
    if (now - this.lastSentAt < SEND_INTERVAL_MS) return;

    const viewer = frame.getViewerPose(refSpace);
    if (!viewer) return;
    this.lastSentAt = now;

    // 頭は「開始時の姿勢からの差分」。開始時に単位元になる
    const headRestInverse = _restInverse.copy(this.calibration.headRest).invert();
    const head = this.toNode(viewer.transform, headRestInverse);

    const hands: Record<'left' | 'right', PoseNode | null> = { left: null, right: null };
    const curls: Record<'left' | 'right', FingerCurls> = {
      left: RELAXED_CURLS,
      right: RELAXED_CURLS,
    };
    const spread = { left: 0.5, right: 0.5 };
    for (const source of session.inputSources) {
      const side = source.handedness;
      if (side !== 'left' && side !== 'right') continue;

      // 素手: 手首関節をそのまま手として使い、指も関節から作る
      if (source.hand) {
        const reading = this.handReader.read(frame, source.hand, side, refSpace);
        if (!reading) {
          this.handReader.forget(side);
          continue;
        }
        hands[side] = this.toNode(reading.wrist.transform, null, WRIST_TO_HAND[side]);
        curls[side] = reading.curls;
        spread[side] = reading.spread;
        continue;
      }

      this.handReader.forget(side);
      if (!source.gripSpace) continue;
      const pose = frame.getPose(source.gripSpace, refSpace);
      if (!pose) continue;
      _grip.copy(GRIP_TO_HAND[side]).multiply(WRIST_OFFSET[side]);
      hands[side] = this.toNode(pose.transform, null, _grip);
      curls[side] = CONTROLLER_CURLS;
    }

    // コントローラが片方でも取れないときは、体側に下ろした位置で埋める
    const fallback = (sign: number): PoseNode => ({
      position: [sign * 0.21, Math.max(head.position[1] - 0.62, 0.1), 0.03] as Vec3,
      rotation: [0, 0, sign * -0.707, 0.707] as Quat,
    });

    const packet: Omit<Packet, 'sequence' | 'timestamp'> = {
      pose: {
        head,
        leftHand: hands.left ?? fallback(1),
        rightHand: hands.right ?? fallback(-1),
      },
    };
    // 体は補間の要なので毎パケット送る(取れないフレームは送らず、視聴者側は頭からの推定に戻る)
    const body = readBody(frame as BodyFrame, refSpace, (p, out) => this.toWirePosition(p, out));
    if (body) packet.body = body;
    if (this.publisher.packetIndex % FINGER_EVERY === 0) {
      packet.fingers = {
        leftCurls: curls.left,
        rightCurls: curls.right,
        leftSpread: spread.left,
        rightSpread: spread.right,
      };
    }
    this.publisher.send(packet, now);
  }

  close(): void {
    this.publisher.close();
    this.calibration = null;
    this.onStatus?.('HMD配信を停止しました');
  }
}

const _restInverse = new THREE.Quaternion();
const _grip = new THREE.Quaternion();
