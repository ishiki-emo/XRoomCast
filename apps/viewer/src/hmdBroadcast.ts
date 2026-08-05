/**
 * HMDから直接配信する(VSeeFace・ブリッジなしでヘッドセット単体で配信)。
 *
 * ワイヤ形式が head / leftHand / rightHand の3ノードだけなので、HMDが持つ
 * 3点トラッキングとそのまま一致する。**送信側でIKを解く必要はない**
 * (視聴者側の PoseApplier + twoBoneIK が全身を解いている)。
 * ブリッジがVSeeFaceのフルボディを3点へ圧縮しているのと同じ位置づけ。
 *
 * SFUへの publish 手順はブリッジ(apps/bridge/src/sfu.ts)と同じで、
 * App SecretはWorkerのプロキシ側にあるためブラウザには出てこない。
 */
import * as THREE from 'three';
import { encodePacket, type Packet, type PoseNode, type Quat, type Vec3 } from '@xroomcast/protocol';
import type { AuthProvider } from '@xroomcast/sync';
import { withRoom } from '@xroomcast/sync';

const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const DATA_CHANNEL_NAME = 'pose';
const SEND_INTERVAL_MS = 1000 / 30;
/** パブリッシャー登録のハートビート(Worker側は15分で失効とみなす) */
const HEARTBEAT_MS = 4 * 60 * 1000;

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

  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionId: string | null = null;
  private heartbeat: number | null = null;
  private calibration: Calibration | null = null;
  private sequence = 0;
  private startedAt = 0;
  private lastSentAt = 0;
  /** 表示中のアバターの頭の高さ(m)。身長補正に使う */
  private avatarHeight: number | null = null;

  /** アバターが切り替わったら教える(次のキャリブレーションから反映される) */
  setAvatarHeight(height: number): void {
    this.avatarHeight = height > 0.2 ? height : null;
  }

  /** 立ち位置と向きを取り直す(姿勢が崩れたときや、立ち位置を変えたとき) */
  recalibrate(): void {
    this.calibration = null;
  }

  constructor(
    private readonly room: string,
    private readonly auth: AuthProvider,
    /** 配信者名。席(slot)の割り当てとコンソールの自動席解決の鍵になる */
    private readonly pid: () => string = () => 'hmd',
  ) {}

  get active(): boolean {
    return this.channel?.readyState === 'open';
  }

  private async api(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(withRoom(path, this.room), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await this.auth.headers()) },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
    return data;
  }

  /** SFUへパブリッシャーとして接続する(ブリッジと同じ手順) */
  async connect(): Promise<void> {
    this.onStatus?.('SFUへ接続中...');
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: CF_STUN_URL }],
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;

    // m=applicationセクションを作るためのダミーチャネル
    pc.createDataChannel('bootstrap');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const session = await this.api('/api/sfu/sessions/new', { sdp: offer.sdp });
    this.sessionId = String(session.sessionId);
    await pc.setRemoteDescription({ type: 'answer', sdp: String(session.sdp) });

    const result = await this.api('/api/sfu/datachannels/new', {
      sessionId: this.sessionId,
      dataChannels: [{ location: 'local', dataChannelName: DATA_CHANNEL_NAME }],
    });
    const channels = result.dataChannels as { id: number }[] | undefined;
    const channelId = channels?.[0]?.id;
    if (channelId === undefined) throw new Error('DataChannel IDが取得できませんでした');

    const channel = pc.createDataChannel(DATA_CHANNEL_NAME, {
      negotiated: true,
      id: channelId,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DataChannelのopen待ちがタイムアウト')), 15000);
      channel.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      channel.onerror = () => {
        clearTimeout(timer);
        reject(new Error('DataChannelの接続に失敗しました'));
      };
    });
    this.channel = channel;

    await this.register();
    this.heartbeat = window.setInterval(() => void this.register(), HEARTBEAT_MS);
    this.startedAt = performance.now();
    this.sequence = 0;
    this.onStatus?.('HMDから配信中');
  }

  /** 視聴者が購読できるよう、自分のセッションIDを登録する */
  private async register(): Promise<void> {
    if (!this.sessionId) return;
    // pid はブリッジと席を分ける・再接続で同じ席を保つための固定ID。
    // コンソールの配信者名と同じ値を使う(自動席解決がそれを前提にする)
    await this.api('/api/sfu/publisher', { sessionId: this.sessionId, pid: this.pid() });
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

  private toNode(
    transform: XRRigidTransform,
    restInverse: THREE.Quaternion | null,
    extra?: THREE.Quaternion,
  ): PoseNode {
    const calibration = this.calibration!;
    const p = transform.position;
    const o = transform.orientation;
    _v.set(p.x, p.y, p.z)
      .sub(calibration.origin)
      .applyQuaternion(calibration.yaw)
      .multiplyScalar(calibration.scale);
    _q.set(o.x, o.y, o.z, o.w).premultiply(calibration.yaw);
    if (extra) _q.multiply(extra);
    if (restInverse) _q.premultiply(restInverse);
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

    let leftHand: PoseNode | null = null;
    let rightHand: PoseNode | null = null;
    for (const source of session.inputSources) {
      if (!source.gripSpace || (source.handedness !== 'left' && source.handedness !== 'right')) {
        continue;
      }
      const pose = frame.getPose(source.gripSpace, refSpace);
      if (!pose) continue;
      _grip.copy(GRIP_TO_HAND[source.handedness]).multiply(WRIST_OFFSET[source.handedness]);
      const node = this.toNode(pose.transform, null, _grip);
      if (source.handedness === 'left') leftHand = node;
      else rightHand = node;
    }

    // コントローラが片方でも取れないときは、体側に下ろした位置で埋める
    const fallback = (sign: number): PoseNode => ({
      position: [sign * 0.21, Math.max(head.position[1] - 0.62, 0.1), 0.03] as Vec3,
      rotation: [0, 0, sign * -0.707, 0.707] as Quat,
    });

    const packet: Packet = {
      sequence: this.sequence++ & 0xffff,
      timestamp: Math.round(now - this.startedAt) >>> 0,
      pose: {
        head,
        leftHand: leftHand ?? fallback(1),
        rightHand: rightHand ?? fallback(-1),
      },
    };
    // encodePacketの戻りはUint8Array<ArrayBufferLike>。sendはArrayBufferを要求する
    const bytes = encodePacket(packet);
    this.channel!.send(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  }

  close(): void {
    if (this.heartbeat !== null) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    this.channel = null;
    this.pc?.close();
    this.pc = null;
    this.sessionId = null;
    this.calibration = null;
    this.onStatus?.('HMD配信を停止しました');
  }
}

const _restInverse = new THREE.Quaternion();
const _grip = new THREE.Quaternion();
