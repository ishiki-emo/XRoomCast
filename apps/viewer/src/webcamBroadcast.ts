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
import type { AuthProvider, SampledFrame } from '@xroomcast/sync';
import { OneEuroFilter } from './oneEuroFilter';
import { PosePublisher } from './posePublisher';
import {
  EXPRESSION_NAMES,
  POSE,
  expressionsFromBlendshapes,
  fingersFromHand,
  assignHands,
  handAxes,
  handRotation,
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
/**
 * 揺れ取り(One Euro)の設定。[止まっているときのならし(Hz), 速さに応じてならしを弱める度合い]。
 * 位置はメートル、回転はクォータニオンの成分で測る。手は頭より推定の揺れが大きいので強めにならす
 */
const HEAD_POSITION_FILTER = [1.5, 10] as const;
const HEAD_ROTATION_FILTER = [2, 6] as const;
const HAND_POSITION_FILTER = [0.8, 6] as const;
const HAND_ROTATION_FILTER = [1, 3] as const;
const FINGER_FILTER = [1.5, 2] as const;
/** まばたきが遅れないよう、表情は軽めにならす */
const EXPRESSION_FILTER = [2.5, 4] as const;
/**
 * 手の前後(奥行き)の動きを縮める割合。単眼カメラの奥行きは揺れが大きく、
 * そのままだと手が前後にがたつく
 */
const HAND_DEPTH_SCALE = 0.6;
/** 見えなくなった手を体側へ下ろしていく割合(1フレームあたり) */
const HAND_RETURN_RATE = 0.08;
/**
 * 手首が「見える」とみなす推定の確からしさ。入りと出で値を変え(ヒステリシス)、
 * さらに続けて満たしたフレーム数で切り替える。境目で見える・見えないがぱたぱた切り替わると、
 * そのたびに下ろした位置と行き来して手がワープする
 */
const WRIST_SHOW = 0.65;
const WRIST_HIDE = 0.35;
const SHOW_AFTER_FRAMES = 3;
const HIDE_AFTER_FRAMES = 12;
/** 1フレームでこれ以上(m)動いた手首は推定の飛びとみなして捨てる。続いたら受け入れる */
const WRIST_JUMP = 0.18;
const MAX_JUMP_SKIPS = 4;
/** 頭からこれ以上(m)離れた手首はあり得ないので縮める(腕の長さの目安) */
const WRIST_REACH = 0.85;
/** 推定の速さを表示する間隔 */
const RATE_REPORT_MS = 1000;
/** 手が見えないときの指(待機モーションと同じ軽い曲げ) */
const RELAXED_CURLS: FingerCurls = [0.11, 0.16, 0.16, 0.16, 0.18];

interface HandState {
  position: THREE.Vector3;
  rotation: THREE.Quaternion;
  curls: FingerCurls;
  spread: number;
  positionFilter: OneEuroFilter;
  rotationFilter: OneEuroFilter;
  fingerFilter: OneEuroFilter;
  /** 手首を追えているか(ヒステリシス付き) */
  tracked: boolean;
  /** tracked を切り替える条件を続けて満たしたフレーム数 */
  streak: number;
  /** 最後に受け入れた手首の位置(飛び値の判定用) */
  lastWrist: THREE.Vector3 | null;
  jumpSkips: number;
}

const filterOf = ([minCutoff, beta]: readonly [number, number]) =>
  new OneEuroFilter(minCutoff, beta);

/** ベクトルを揺れ取りに通す(out へ書く) */
function filterVector(
  filter: OneEuroFilter,
  v: THREE.Vector3,
  time: number,
  out: THREE.Vector3,
): void {
  const [x, y, z] = filter.filter([v.x, v.y, v.z], time, _values);
  out.set(x!, y!, z!);
}

/**
 * 回転を揺れ取りに通す。q と -q は同じ回転なので、前回の出力と同じ半球にそろえてから成分ごとにならす
 * (そろえないと、半球をまたいだ瞬間に成分が反転して大きく回る)
 */
function filterRotation(
  filter: OneEuroFilter,
  q: THREE.Quaternion,
  time: number,
  out: THREE.Quaternion,
): void {
  const sign = q.dot(out) < 0 ? -1 : 1;
  const [x, y, z, w] = filter.filter(
    [q.x * sign, q.y * sign, q.z * sign, q.w * sign],
    time,
    _values,
  );
  out.set(x!, y!, z!, w!).normalize();
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
  private readonly headPositionFilter = filterOf(HEAD_POSITION_FILTER);
  private readonly headRotationFilter = filterOf(HEAD_ROTATION_FILTER);
  private readonly expressionFilter = filterOf(EXPRESSION_FILTER);
  /** 推定の回数(速さの表示用) */
  private detections = 0;
  private lastRateAt = 0;
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
    this.detections = 0;
    this.lastRateAt = performance.now();
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
    this.reportRate(now, result.face !== null);
    if (now - this.lastSentAt >= SEND_INTERVAL_MS) {
      this.lastSentAt = now;
      this.send(now);
    }
  }

  /**
   * 推定が1秒に何回回っているかを出す。少ない(15回を切る)と動きが飛び飛びになるので、
   * カクつきが「揺れ」なのか「PCの速さ」なのかを見分ける手がかりにする
   */
  private reportRate(now: number, faceFound: boolean): void {
    this.detections++;
    if (now - this.lastRateAt < RATE_REPORT_MS) return;
    const rate = Math.round((this.detections * 1000) / (now - this.lastRateAt));
    this.detections = 0;
    this.lastRateAt = now;
    if (!faceFound) return; // 「顔が見つかりません」を上書きしない
    const slow =
      rate < 15 ? '。PCの処理が追いついていません(ほかのアプリを閉じると改善します)' : '';
    this.onStatus?.(`Webカメラから配信中(推定 ${rate}回/秒${slow})`);
  }

  private update(result: TrackingResult, now: number): void {
    const time = now / 1000;
    const face = result.face;
    if (face) {
      this.lastFaceAt = now;
      if (!this.rest) {
        this.rest = { rotation: face.rotation.clone(), position: face.position.clone() };
        this.onStatus?.('Webカメラから配信中(今の向きを正面にしました)');
      }
      // 向きは「今 × 開始時の逆」(ワールド系の差分。HMD配信と同じ約束)
      _q.copy(face.rotation).multiply(_qInverse.copy(this.rest.rotation).invert());
      filterRotation(this.headRotationFilter, _q, time, this.head.rotation);
      _v.subVectors(face.position, this.rest.position).clampScalar(
        -HEAD_MOVE_LIMIT,
        HEAD_MOVE_LIMIT,
      );
      _v.y += this.headHeight;
      filterVector(this.headPositionFilter, _v, time, this.head.position);

      const next = expressionsFromBlendshapes(face.blendshapes);
      const filtered = this.expressionFilter.filter(
        EXPRESSION_NAMES.map((name) => next[name]),
        time,
        _values,
      );
      EXPRESSION_NAMES.forEach((name, i) => {
        this.expressions.set(name, Math.min(1, Math.max(0, filtered[i]!)));
      });
    }

    // 手: 位置は体の推定の手首(頭からの相対)、向き・指は手の推定
    const pose = result.pose;
    const handOf = assignHands(result.hands, pose);

    for (const side of ['left', 'right'] as const) {
      const state = this.hands[side];
      const wrist = pose?.world[side === 'left' ? POSE.leftWrist : POSE.rightWrist];
      const leftEar = pose?.world[POSE.leftEar];
      const rightEar = pose?.world[POSE.rightEar];
      const visibility = leftEar && rightEar ? (wrist?.visibility ?? 0) : 0;
      updateTracked(state, visibility);
      let curls: FingerCurls = RELAXED_CURLS;
      if (state.tracked && wrist && leftEar && rightEar && visibility > WRIST_HIDE) {
        // 耳の中点(=頭の中心)からの位置。奥行きは縮め、腕の長さを超えないようにする
        toWire(leftEar, _a).add(toWire(rightEar, _b)).multiplyScalar(0.5);
        toWire(wrist, _v).sub(_a);
        _v.z *= HAND_DEPTH_SCALE;
        if (_v.length() > WRIST_REACH) _v.setLength(WRIST_REACH);
        // 飛び値は捨てて前の位置を使う(続いたら本当に動いたとみなして受け入れる)
        if (
          state.lastWrist &&
          _v.distanceTo(state.lastWrist) > WRIST_JUMP &&
          state.jumpSkips < MAX_JUMP_SKIPS
        ) {
          state.jumpSkips++;
          _v.copy(state.lastWrist);
        } else {
          state.jumpSkips = 0;
          (state.lastWrist ??= new THREE.Vector3()).copy(_v);
        }
        _v.add(this.head.position);

        const hand = handOf[side];
        if (hand) {
          handAxes(hand.world, _finger, _thumb);
          handRotation(side, _finger, _thumb, _q);
          const fingers = fingersFromHand(hand.world);
          curls = fingers.curls;
          state.spread = fingers.spread;
        } else {
          // 手の形が取れないときは、前腕の向きに指先を伸ばし、親指を上にした形にする
          // (腕を組んだときに手のひらが体の方を向く。下ろした腕では親指が前になる)
          const elbow = pose.world[side === 'left' ? POSE.leftElbow : POSE.rightElbow]!;
          toWire(wrist, _finger).sub(toWire(elbow, _a));
          handRotation(side, _finger, _thumb.set(0, 1, 0), _q);
        }
      } else {
        // 見えない手は体側へ下ろしていく(画面外に出した手で固まらないように)
        state.lastWrist = null;
        const rest = restHand(side, this.head.position.y);
        _v.copy(state.position).lerp(rest.position, HAND_RETURN_RATE);
        _q.copy(state.rotation).slerp(rest.rotation, HAND_RETURN_RATE);
      }
      // 見えていても見えていなくても揺れ取りに通す(見え隠れの境目で位置が飛ばないように)
      filterVector(state.positionFilter, _v, time, state.position);
      filterRotation(state.rotationFilter, _q, time, state.rotation);
      state.curls = state.fingerFilter
        .filter(curls, time, _values)
        .map((c) => Math.min(1, Math.max(0, c))) as FingerCurls;
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

  /**
   * 手元で推定したいまの姿勢。配信者コンソールのプレビューに直接当てる
   * (届いた姿を待つと、通信と視聴側の再生の遅れで0.2秒以上もたついて見えるため)
   */
  localFrame(): SampledFrame | null {
    if (!this.active || performance.now() - this.lastFaceAt > FACE_LOST_MS) return null;
    const node = (position: THREE.Vector3, rotation: THREE.Quaternion) => ({
      position: [position.x, position.y, position.z] as Vec3,
      rotation: [rotation.x, rotation.y, rotation.z, rotation.w] as Quat,
    });
    return {
      pose: {
        head: node(this.head.position, this.head.rotation),
        leftHand: node(this.hands.left.position, this.hands.left.rotation),
        rightHand: node(this.hands.right.position, this.hands.right.rotation),
      },
      fingers: {
        leftCurls: this.hands.left.curls,
        rightCurls: this.hands.right.curls,
        leftSpread: this.hands.left.spread,
        rightSpread: this.hands.right.spread,
      },
      expressions: this.expressions,
    };
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
    positionFilter: filterOf(HAND_POSITION_FILTER),
    rotationFilter: filterOf(HAND_ROTATION_FILTER),
    fingerFilter: filterOf(FINGER_FILTER),
    tracked: false,
    streak: 0,
    lastWrist: null,
    jumpSkips: 0,
  };
}

/** 手首を追えているかを、入りと出で別のしきい値とフレーム数で切り替える */
function updateTracked(state: HandState, visibility: number): void {
  const wantsChange = state.tracked ? visibility < WRIST_HIDE : visibility > WRIST_SHOW;
  state.streak = wantsChange ? state.streak + 1 : 0;
  if (state.streak >= (state.tracked ? HIDE_AFTER_FRAMES : SHOW_AFTER_FRAMES)) {
    state.tracked = !state.tracked;
    state.streak = 0;
  }
}

const _values: number[] = [];
const _q = new THREE.Quaternion();
const _qInverse = new THREE.Quaternion();
const _v = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _finger = new THREE.Vector3();
const _thumb = new THREE.Vector3();
