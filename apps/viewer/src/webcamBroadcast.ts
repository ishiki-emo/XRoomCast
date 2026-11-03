/**
 * Webカメラだけで配信する(VSeeFace・ブリッジ・HMDなし)。
 *
 * ブラウザの中で顔・体・手を推定し(webcamTracking.ts)、HMD配信と同じワイヤ形式で送る。
 * 頭は「開始時の顔の向き・位置からの差分」、手は体の推定の手首(頭からの相対位置)と
 * 手の推定の向き・指、表情はブレンドシェイプから作る(webcamPose.ts)。
 * 体のセクションは送らない(視聴者側が頭から腰を推定する)。
 *
 * カメラの映像は推定に使うだけで、どこにも送らない。
 */
import * as THREE from 'three';
import type {
  DictionaryEntry,
  ExpressionEntry,
  FingerCurls,
  Packet,
  Quat,
  Vec3,
} from '@xroomcast/protocol';
import type { AuthProvider } from '@xroomcast/sync';
import { PosePublisher } from './posePublisher';
import {
  EXPRESSION_NAMES,
  POSE,
  expressionsFromBlendshapes,
  fingersFromHand,
  handAxes,
  handRotation,
  sideOfHand,
  toWire,
  type ExpressionName,
} from './webcamPose';
import type { TrackingResult, WebcamTracker } from './webcamTracking';

const SEND_INTERVAL_MS = 1000 / 30;
/** 指と表情は2パケットに1回(15Hz)。ブリッジと同じ */
const DETAIL_EVERY = 2;
/** 辞書と全表情の再送間隔。SFUは一方向なので、途中から見始めた人にも届くよう定期的に送る */
const KEYFRAME_MS = 5000;
/** 顔がこれだけ見つからなければ送るのをやめる(視聴側は5秒で待機モーションへ戻る) */
const FACE_LOST_MS = 1500;
/** 頭の位置の動きの上限(m)。顔の推定が飛んだときにアバターが大きく動かないように */
const HEAD_MOVE_LIMIT = 0.35;
/** アバターが未読み込みのときの頭の高さ(m) */
const DEFAULT_HEAD_HEIGHT = 1.45;
/** 前回値へ寄せる割合。推定の細かい震えを抑える(大きいほど滑らかだが遅れる) */
const SMOOTH_POSE = 0.45;
const SMOOTH_EXPRESSION = 0.4;
/** 手が見えないときの指(待機モーションと同じ軽い曲げ) */
const RELAXED_CURLS: FingerCurls = [0.11, 0.16, 0.16, 0.16, 0.18];

interface HandState {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  curls: FingerCurls;
  spread: number;
  /** 前のフレームで見えていたか(見えなくなったら下ろした位置へ戻していく) */
  seen: boolean;
}

export class WebcamBroadcast {
  onStatus: ((text: string, isError?: boolean) => void) | null = null;

  private readonly publisher: PosePublisher;
  private tracker: WebcamTracker | null = null;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private frameHandle: number | null = null;
  private lastVideoTime = -1;
  private lastSentAt = 0;
  private lastFaceAt = 0;
  private headHeight = DEFAULT_HEAD_HEIGHT;
  /** 開始時の顔の向き・位置(これからの差分を送る)。null は次に顔が見えたときに取る */
  private rest: { rotation: THREE.Quaternion; position: THREE.Vector3 } | null = null;

  private readonly head = { position: new THREE.Vector3(), rotation: new THREE.Quaternion() };
  private readonly hands: Record<'left' | 'right', HandState> = {
    left: restHand('left', DEFAULT_HEAD_HEIGHT),
    right: restHand('right', DEFAULT_HEAD_HEIGHT),
  };
  private readonly expressions = new Map<ExpressionName, number>();
  private readonly sentExpressions = new Map<ExpressionName, number>();
  private lastKeyframeAt = -Infinity;

  constructor(room: string, auth: AuthProvider, pid: () => string) {
    this.publisher = new PosePublisher(room, auth, pid, (text) => this.onStatus?.(text));
  }

  get active(): boolean {
    return this.frameHandle !== null;
  }

  /** 表示中のアバターの頭の高さ(m)。頭の位置の基準にする */
  setAvatarHeight(height: number): void {
    if (height > 0.2) this.headHeight = height;
  }

  /** 今の顔の向き・位置を正面に取り直す */
  recalibrate(): void {
    this.rest = null;
  }

  /**
   * カメラを開いて配信を始める。video にはカメラの映像を流す(本人の確認用に画面へ出してよい)
   */
  async start(video: HTMLVideoElement): Promise<void> {
    this.onStatus?.('カメラを開いています...');
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false,
    });
    video.srcObject = this.stream;
    video.muted = true;
    video.playsInline = true;
    await video.play();
    this.video = video;

    this.onStatus?.('推定のモデルを読み込んでいます(初回は数十MB)...');
    const { WebcamTracker } = await import('./webcamTracking');
    this.tracker = await WebcamTracker.create();

    await this.publisher.connect();
    this.rest = null;
    this.lastFaceAt = performance.now();
    this.lastKeyframeAt = -Infinity;
    this.onStatus?.('Webカメラから配信中(正面を向いてください)');
    this.loop();
  }

  private loop(): void {
    this.frameHandle = requestAnimationFrame(() => this.loop());
    const video = this.video;
    if (!video || !this.tracker || video.readyState < 2) return;
    // 同じフレームを二度推定しない(カメラは30fps前後、画面は60Hz以上のことが多い)
    if (video.currentTime === this.lastVideoTime) return;
    this.lastVideoTime = video.currentTime;

    const now = performance.now();
    const result = this.tracker.detect(video, now);
    this.update(result, now);
    if (now - this.lastSentAt >= SEND_INTERVAL_MS) {
      this.lastSentAt = now;
      this.send(now);
    }
  }

  private update(result: TrackingResult, now: number): void {
    const face = result.face;
    if (face) {
      this.lastFaceAt = now;
      if (!this.rest) {
        this.rest = { rotation: face.rotation.clone(), position: face.position.clone() };
        this.onStatus?.('Webカメラから配信中(今の向きを正面にしました)');
      }
      // 向きは「今 × 開始時の逆」(ワールド系の差分。HMD配信と同じ約束)
      _q.copy(face.rotation).multiply(_qInverse.copy(this.rest.rotation).invert());
      this.head.rotation.slerp(_q, 1 - SMOOTH_POSE);
      _v.subVectors(face.position, this.rest.position).clampScalar(
        -HEAD_MOVE_LIMIT,
        HEAD_MOVE_LIMIT,
      );
      _v.y += this.headHeight;
      this.head.position.lerp(_v, 1 - SMOOTH_POSE);

      const next = expressionsFromBlendshapes(face.blendshapes);
      for (const name of EXPRESSION_NAMES) {
        const previous = this.expressions.get(name) ?? 0;
        this.expressions.set(name, previous + (next[name] - previous) * (1 - SMOOTH_EXPRESSION));
      }
    }

    // 手: 位置は体の推定の手首(頭からの相対)、向き・指は手の推定
    const pose = result.pose;
    const seen = { left: false, right: false };
    const handOf: Record<'left' | 'right', (typeof result.hands)[number] | null> = {
      left: null,
      right: null,
    };
    for (const hand of result.hands) handOf[sideOfHand(hand, pose)] = hand;

    for (const side of ['left', 'right'] as const) {
      const state = this.hands[side];
      const wrist = pose?.world[side === 'left' ? POSE.leftWrist : POSE.rightWrist];
      const leftEar = pose?.world[POSE.leftEar];
      const rightEar = pose?.world[POSE.rightEar];
      const visible = (wrist?.visibility ?? 0) > 0.5 && leftEar && rightEar;
      if (visible && wrist) {
        // 耳の中点(=頭の中心)からの位置を、ワイヤの頭の位置に足す
        toWire(leftEar, _a).add(toWire(rightEar, _b)).multiplyScalar(0.5);
        toWire(wrist, _v).sub(_a).add(this.head.position);
        state.position.lerp(_v, state.seen ? 1 - SMOOTH_POSE : 0.3);
        seen[side] = true;

        const hand = handOf[side];
        if (hand) {
          handAxes(hand.world, _finger, _thumb);
          handRotation(side, _finger, _thumb, _q);
          const fingers = fingersFromHand(hand.world);
          state.curls = fingers.curls;
          state.spread = fingers.spread;
        } else {
          // 手の形が取れないときは、前腕の向きに指先を伸ばし、親指を上にした形にする
          // (腕を組んだときに手のひらが体の方を向く。下ろした腕では親指が前になる)
          const elbow = pose.world[side === 'left' ? POSE.leftElbow : POSE.rightElbow]!;
          toWire(wrist, _finger).sub(toWire(elbow, _a));
          handRotation(side, _finger, _thumb.set(0, 1, 0), _q);
          state.curls = RELAXED_CURLS;
        }
        state.rotation.slerp(_q, state.seen ? 1 - SMOOTH_POSE : 1);
      } else {
        // 見えない手は体側へ下ろしていく(画面外に出した手で固まらないように)
        const rest = restHand(side, this.head.position.y);
        state.position.lerp(rest.position, 0.15);
        state.rotation.slerp(rest.rotation, 0.15);
        state.curls = RELAXED_CURLS;
      }
      state.seen = seen[side];
    }
  }

  private send(now: number): void {
    if (!this.publisher.active) return;
    // 顔を見失ったら送るのをやめる(最後の姿勢で固まって見えるより、待機モーションに戻す)
    if (now - this.lastFaceAt > FACE_LOST_MS) {
      this.onStatus?.('顔が見つかりません(カメラに顔を映してください)', true);
      return;
    }
    const node = (position: THREE.Vector3, rotation: THREE.Quaternion) => ({
      position: [position.x, position.y, position.z] as Vec3,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as Quat,
    });
    const packet: Omit<Packet, 'sequence' | 'timestamp'> = {
      pose: {
        head: node(this.head.position, this.head.rotation),
        leftHand: node(this.hands.left.position, this.hands.left.rotation),
        rightHand: node(this.hands.right.position, this.hands.right.rotation),
      },
    };
    if (this.publisher.packetIndex % DETAIL_EVERY === 0) {
      packet.fingers = {
        leftCurls: this.hands.left.curls,
        rightCurls: this.hands.right.curls,
        leftSpread: this.hands.left.spread,
        rightSpread: this.hands.right.spread,
      };
      const keyframe = now - this.lastKeyframeAt >= KEYFRAME_MS;
      if (keyframe) {
        this.lastKeyframeAt = now;
        packet.dictionary = DICTIONARY;
        this.sentExpressions.clear();
      }
      const changed = this.changedExpressions();
      if (changed.length > 0) packet.expressions = changed;
    }
    this.publisher.send(packet, now);
  }

  /** 前回送った値から変わった表情だけ(視聴側は受け取った値を保持する) */
  private changedExpressions(): ExpressionEntry[] {
    const entries: ExpressionEntry[] = [];
    EXPRESSION_NAMES.forEach((name, id) => {
      const value = this.expressions.get(name) ?? 0;
      const sent = this.sentExpressions.get(name);
      if (sent !== undefined && Math.abs(sent - value) < 1 / 255) return;
      this.sentExpressions.set(name, value);
      entries.push({ id, value });
    });
    return entries;
  }

  stop(): void {
    if (this.frameHandle !== null) {
      cancelAnimationFrame(this.frameHandle);
      this.frameHandle = null;
    }
    this.publisher.close();
    this.tracker?.close();
    this.tracker = null;
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = null;
    if (this.video) this.video.srcObject = null;
    this.video = null;
    this.rest = null;
    this.lastVideoTime = -1;
    this.onStatus?.('Webカメラ配信を停止しました');
  }
}

const DICTIONARY: DictionaryEntry[] = EXPRESSION_NAMES.map((name, id) => ({ id, name }));

/** 腕を体側に下ろした手(HMD配信の手が取れないときと同じ位置・向き) */
function restHand(side: 'left' | 'right', headY: number): HandState {
  const sign = side === 'left' ? 1 : -1;
  return {
    position: new THREE.Vector3(sign * 0.21, Math.max(headY - 0.62, 0.1), 0.03),
    rotation: new THREE.Quaternion(0, 0, sign * -0.707, 0.707).normalize(),
    curls: RELAXED_CURLS,
    spread: 0.5,
    seen: false,
  };
}

const _q = new THREE.Quaternion();
const _qInverse = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _finger = new THREE.Vector3();
const _thumb = new THREE.Vector3();
