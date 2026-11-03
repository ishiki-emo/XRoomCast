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
 * 手の形と表情は VRChat 準拠のハンドジェスチャーで決める(vrGestures.ts / gestureExpressions.ts)。
 * コントローラはグリップ・トリガー・親指からジェスチャーを判定して指の形を作り、
 * 素手は指をそのまま送りつつ、指の形から判定したジェスチャーを表情の切り替えに使う。
 * 操作パネルで選んだ表情は、ジェスチャーより優先する。
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
import type { AuthProvider, SampledFrame } from '@xroomcast/sync';
import { readBody, type BodyFrame } from './bodyTracking';
import { ExpressionChannel } from './expressionChannel';
import {
  GestureExpressionMixer,
  type GestureExpressionSettings,
} from './gestureExpressions';
import { HandReader, WRIST_TO_HAND } from './handTracking';
import { PosePublisher } from './posePublisher';
import {
  GESTURE,
  GestureStabilizer,
  gestureFromController,
  gestureFromCurls,
  gesturePose,
  readController,
  type GestureReading,
} from './vrGestures';

const SEND_INTERVAL_MS = 1000 / 30;
/** 指は2パケットに1回(15Hz)。ブリッジと同じ頻度で、視聴者側も保持で滑らかに見える */
const FINGER_EVERY = 2;

/**
 * コントローラの指の形を、ジェスチャーの形へ寄せていく速さ(1/30秒あたりの割合。約0.1秒で寄る)。
 * ジェスチャーが変わった瞬間に指がパッと切り替わると不自然に見えるため。
 * 姿勢は毎フレーム作るので、フレームの間隔に合わせて割合を換算する
 */
const CURL_FOLLOW = 0.35;
/** ジェスチャーが切り替わるまでに、同じ判定が続く必要のある時間(コントローラは入力が明確なので短く) */
const CONTROLLER_GESTURE_HOLD_MS = 60;
const HAND_GESTURE_HOLD_MS = 130;
/** 手元の姿勢をプレビューへ当て続ける期限(これより古ければ、VRを出たか止まったとみなす) */
const LOCAL_FRAME_FRESH_MS = 500;
const NEUTRAL: GestureReading = { gesture: GESTURE.neutral, weight: 0 };
/**
 * 位置合わせは、頭の高さがこの時間落ち着いてから行う。VRに入った直後の数フレームは、
 * 端末によって頭の位置がまだ正しく取れていない(高さが0付近など)ことがあり、
 * そこで合わせると身長の比が大きく狂う(一人称でアバターが縮んで見えた)
 */
const CALIBRATE_STABLE_MS = 500;
/** 落ち着いているとみなす高さの揺れ(m) */
const CALIBRATE_STABLE_RANGE = 0.03;
/** これより低い頭の高さは、まだ取れていないとみなす(座っていても目はこれより高い) */
const CALIBRATE_MIN_EYE = 0.6;
/** SFUへの接続を試す回数 */
const CONNECT_ATTEMPTS = 3;
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
  /**
   * 持ち上げる高さ(m、現実の長さ)。座りモードで、座った目の高さをアバターの立った目の高さまで上げる。
   * 立ちモードでは0
   */
  heightOffset: number;
}

/**
 * 立って遊ぶか、座って遊ぶか(VRChat の立ちモード・座りモードと同じ考え方)。
 * - standing: 位置合わせのときの目の高さで身長の比を決める。しゃがみ・前かがみもそのまま映る
 * - seated: 座っていても、アバターは立った姿勢になる。座った目の高さをアバターの立った目の高さまで
 *   持ち上げ(頭と手の位置関係はそのまま)、体(腰・足)は送らない(視聴側が立った姿勢として推定する)。
 *   途中で立ち上がるとアバターは浮く(VRChat と同じ)
 */
export type PlayMode = 'standing' | 'seated';
const PLAY_MODE_KEY = 'xroomcast.hmd.playMode';
/** アバターが未読み込みのときの、立ったときの目の高さ(m) */
const DEFAULT_STANDING_EYE = 1.5;

/**
 * 体格の設定(この端末のブラウザに保存)。
 * - realHeight: リアルの身長(m)。null は自動(位置合わせのときの目の高さから身長の比を出す)。
 *   選ぶと、身長から見積もった立った目の高さ(× HUMAN_EYE_RATIO)とアバターの目の高さで比を決める。
 *   位置合わせのときの姿勢や、立っている・座っているに左右されないので、配信者によらず同じ感覚になる
 *   (床の高さが正しい前提)
 * - heightShift: 目線の高さ(m、現実の長さ)。OVR Advanced Settings の空間の高さのオフセットと同じで、
 *   大きさは変えずに、自分の追跡位置ごと上下にずらす。下げるとアバターの頭ごと下がって膝が曲がり、
 *   上げると浮く。自分に入っているときは、アバターの目と自分の目は重なったまま、周りの世界が上下する。
 *   位置合わせはやり直さず、その場で効く
 */
export interface BodySettings {
  realHeight: number | null;
  heightShift: number;
}
const BODY_SETTINGS_KEY = 'xroomcast.hmd.body';
export const REAL_HEIGHT_RANGE = [1.3, 2.0] as const;
export const HEIGHT_SHIFT_RANGE = [-0.3, 0.3] as const;

function loadBodySettings(): BodySettings {
  try {
    const value = JSON.parse(localStorage.getItem(BODY_SETTINGS_KEY) ?? 'null') as Partial<BodySettings> | null;
    const realHeight =
      typeof value?.realHeight === 'number' &&
      value.realHeight >= REAL_HEIGHT_RANGE[0] &&
      value.realHeight <= REAL_HEIGHT_RANGE[1]
        ? value.realHeight
        : null;
    const heightShift =
      typeof value?.heightShift === 'number'
        ? Math.min(HEIGHT_SHIFT_RANGE[1], Math.max(HEIGHT_SHIFT_RANGE[0], value.heightShift))
        : 0;
    return { realHeight, heightShift };
  } catch {
    return { realHeight: null, heightShift: 0 };
  }
}

/** 人の立った目の高さの、身長に対する割合(人体寸法の平均的な値) */
const HUMAN_EYE_RATIO = 0.93;
/** 位置合わせを数え始めてから合わせるまでの秒数(その間に楽な姿勢に戻ってもらう) */
const RECALIBRATE_COUNTDOWN_MS = 3000;
/** 身長を選んでいるとき、測った目の高さとの差がこれを超えたら、床の高さか身長の設定のずれを知らせる */
const EYE_MISMATCH_WARN = 0.08;

function loadPlayMode(): PlayMode {
  try {
    return localStorage.getItem(PLAY_MODE_KEY) === 'seated' ? 'seated' : 'standing';
  } catch {
    return 'standing';
  }
}

export class HmdBroadcast {
  onStatus: ((text: string, isError?: boolean) => void) | null = null;

  private readonly publisher: PosePublisher;
  private calibration: Calibration | null = null;
  private lastSentAt = 0;
  /** 表示中のアバターの頭の高さ(m)。身長補正に使う */
  private avatarHeight: number | null = null;
  /**
   * アバターの頭の骨から目までのずれ(アバターのレスト姿勢で、正面+Z の座標)。
   * HMDの頭の位置は目の位置なので、送るときはこのぶん頭の骨の位置へ戻す
   * (そのまま頭の骨に合わせると、アバターの目が配信者の目より上に来て、一人称で視点が低く感じた)
   */
  private avatarEye = new THREE.Vector3();
  /** 位置合わせ待ちの、頭の高さが落ち着き始めた時刻と高さ */
  private settling: { since: number; y: number } | null = null;
  private mode: PlayMode = loadPlayMode();
  private body: BodySettings = loadBodySettings();
  /** アバターの身長(頭頂まで、m)。リアルの身長を選んだときの比に使う */
  private avatarFullHeight: number | null = null;
  /** 位置合わせを始めてよい時刻(合わせ直しのときは、数秒数えてから合わせる) */
  private calibrateAfter = 0;
  /** 位置合わせまでの残り秒数(数えていないときは null)。パネルに出す */
  onCalibrationCountdown: ((seconds: number | null) => void) | null = null;
  /** 体格の設定が変わったとき(画面とパネルの表示を合わせる) */
  readonly bodyListeners: ((settings: Readonly<BodySettings>) => void)[] = [];

  get bodySettings(): Readonly<BodySettings> {
    return this.body;
  }

  /** アバターの身長(頭頂まで、m)。分からなければ null */
  get avatarStature(): number | null {
    return this.avatarFullHeight;
  }

  setAvatarStature(height: number | null): void {
    this.avatarFullHeight = height && height > 0.3 ? height : null;
  }

  /**
   * 体格の設定を変える(保存する)。身長が変わったら位置を合わせ直す。
   * 目線の高さは追跡位置をずらすだけなので、合わせ直さずにその場で効く
   */
  setBodySettings(next: BodySettings): void {
    const heightChanged = next.realHeight !== this.body.realHeight;
    this.body = {
      realHeight:
        next.realHeight === null
          ? null
          : Math.min(REAL_HEIGHT_RANGE[1], Math.max(REAL_HEIGHT_RANGE[0], next.realHeight)),
      heightShift: Math.min(HEIGHT_SHIFT_RANGE[1], Math.max(HEIGHT_SHIFT_RANGE[0], next.heightShift)),
    };
    try {
      localStorage.setItem(BODY_SETTINGS_KEY, JSON.stringify(this.body));
    } catch {
      // 覚えられないだけ
    }
    for (const listener of this.bodyListeners) listener(this.body);
    if (heightChanged && this.calibration) this.recalibrate();
  }

  /** 自動のとき、前回の位置合わせから見積もったリアルの身長(m)。身長を選び始めるときの初期値に使う */
  estimatedRealHeight(): number {
    const scale = this.calibration?.scale;
    if (this.avatarHeight && scale && this.mode === 'standing') {
      // 立ちモードで合わせた比から、配信者の立った目の高さ → 身長を逆算する
      const eye = (this.avatarHeight + this.avatarEye.y) / scale;
      return Math.round((eye / HUMAN_EYE_RATIO) * 100) / 100;
    }
    return 1.65;
  }

  get playMode(): PlayMode {
    return this.mode;
  }

  /** 立ち/座りを切り替える。位置を合わせ直す(座りかたが変わると、目の高さの基準が変わるため) */
  setPlayMode(mode: PlayMode): void {
    this.mode = mode;
    try {
      localStorage.setItem(PLAY_MODE_KEY, mode);
    } catch {
      // 覚えられないだけ
    }
    this.recalibrate();
  }
  private readonly handReader = new HandReader();
  private readonly gestureMixer = new GestureExpressionMixer();
  private readonly expressions = new ExpressionChannel(this.gestureMixer.expressionNames());
  private readonly stabilizers = {
    controller: {
      left: new GestureStabilizer(CONTROLLER_GESTURE_HOLD_MS),
      right: new GestureStabilizer(CONTROLLER_GESTURE_HOLD_MS),
    },
    hand: {
      left: new GestureStabilizer(HAND_GESTURE_HOLD_MS),
      right: new GestureStabilizer(HAND_GESTURE_HOLD_MS),
    },
  };
  /** いま送っているコントローラの指(ジェスチャーの形へなめらかに寄せる) */
  private readonly controllerCurls: Record<'left' | 'right', FingerCurls> = {
    left: [...RELAXED_CURLS] as FingerCurls,
    right: [...RELAXED_CURLS] as FingerCurls,
  };
  private readonly controllerSpread = { left: 0.5, right: 0.5 };
  private lastExpressionAt = 0;
  /** 手元で作った最新の姿勢(配信していなくても作る。プレビューのアバターへ直接当てる) */
  private latest: SampledFrame | null = null;
  private latestAt = 0;

  /**
   * 手元で作ったいまの姿勢。配信者コンソールのアバターに直接当てる
   * (届いた姿を待つと、配信前は何も届かず、配信中も通信と再生の遅れでもたつくため)
   */
  localFrame(): SampledFrame | null {
    if (!this.latest || performance.now() - this.latestAt > LOCAL_FRAME_FRESH_MS) return null;
    return this.latest;
  }

  /** ジェスチャーへの表情の割り当て(配信者ページで変える) */
  get gestureSettings(): Readonly<GestureExpressionSettings> {
    return this.gestureMixer.currentSettings;
  }

  setGestureSettings(settings: GestureExpressionSettings): void {
    this.gestureMixer.setSettings(settings);
    for (const name of this.gestureMixer.expressionNames()) this.expressions.ensure(name);
  }

  /** 操作パネルで選んだ表情(null でジェスチャーに戻す) */
  setExpressionOverride(expression: string | null): void {
    this.gestureMixer.setOverride(expression);
    if (expression) this.expressions.ensure(expression);
  }

  /** アバターが切り替わったら教える(次のキャリブレーションから反映される) */
  setAvatarHeight(height: number): void {
    this.avatarHeight = height > 0.2 ? height : null;
  }

  /** アバターの頭の骨から目までのずれ(レスト姿勢・正面+Z)。分からなければ null */
  setAvatarEye(offset: THREE.Vector3 | null): void {
    this.avatarEye.copy(offset ?? _noEyeOffset);
  }

  /**
   * 位置合わせを試す。頭の位置が実際に追跡できていて、高さが少しのあいだ落ち着いたら合わせる。
   * 合わせたら true(それまでは毎フレーム呼ぶ)
   */
  tryCalibrate(viewer: XRViewerPose, now = performance.now()): boolean {
    if (now < this.calibrateAfter) {
      this.onCalibrationCountdown?.(Math.ceil((this.calibrateAfter - now) / 1000));
      this.onStatus?.('楽な姿勢で正面を向いてください。少しあとで位置を合わせます...');
      return false;
    }
    this.onCalibrationCountdown?.(null);
    const y = viewer.transform.position.y;
    // 推定の位置(追跡が切れて向きだけのとき等)や、低すぎる高さでは合わせない
    if (viewer.emulatedPosition || y < CALIBRATE_MIN_EYE) {
      this.settling = null;
      this.onStatus?.('位置を合わせています。正面を向いて、少しそのままでいてください...');
      return false;
    }
    if (!this.settling || Math.abs(y - this.settling.y) > CALIBRATE_STABLE_RANGE) {
      this.settling = { since: now, y };
      this.onStatus?.('位置を合わせています。正面を向いて、少しそのままでいてください...');
      return false;
    }
    if (now - this.settling.since < CALIBRATE_STABLE_MS) return false;
    this.settling = null;
    this.calibrate(viewer);
    return true;
  }

  /** 立ち位置と向きを取り直す(姿勢が崩れたときや、立ち位置を変えたとき) */
  recalibrate(): void {
    this.calibration = null;
    this.settling = null;
    // 押した直後はパネルを指していて前かがみなことが多い(座りモードでは、その低い目の高さで合わせると、
    // 座り直したときにアバターが浮いた)。数秒数えて、楽な姿勢に戻ってから合わせる
    this.calibrateAfter = performance.now() + RECALIBRATE_COUNTDOWN_MS;
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
    this.connecting = this.connectWithRetry().then(() => {
      this.expressions.restart();
      this.lastExpressionAt = performance.now();
      this.onStatus?.('HMDから配信中');
    });
    try {
      await this.connecting;
    } catch (error) {
      this.connecting = null;
      throw error;
    }
  }

  /**
   * SFUへの接続を、失敗したら少し待ってやり直す(最大 CONNECT_ATTEMPTS 回)。
   * DataChannel が開かないまま時間切れになることがあり、1回で諦めると配信が始まらないままになる
   */
  private async connectWithRetry(): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.publisher.connect();
        return;
      } catch (error) {
        this.publisher.close();
        if (attempt >= CONNECT_ATTEMPTS) throw error;
        console.warn(`[hmd] 接続に失敗しました(${attempt}回目)。やり直します:`, error);
        this.onStatus?.(`接続をやり直しています(${attempt + 1}/${CONNECT_ATTEMPTS})...`);
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  }

  /** 接続中・接続済みなら、その完了(席の登録まで)。接続していなければ null */
  connecting: Promise<void> | null = null;

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

    // 目の高さの比でアバターに合わせる(床からの高さがそのまま身長の目安になる)。
    // アバター側も目の高さ(頭の骨の高さ + 目までのずれ)で比べる。
    // 座りモードでは、座った目の高さは身長の目安にならないので比は1のまま、アバターの立った目の高さまで持ち上げる
    const eyeHeight = Math.max(p.y, 0.5);
    // アバターの目の高さ
    const avatarEye = this.avatarHeight ? this.avatarHeight + this.avatarEye.y : null;
    const seated = this.mode === 'seated';
    // 身長の比: リアルの身長を選んでいれば、その立った目の高さ(身長 × 人の目の高さの割合)とアバターの目の高さの比
    // (姿勢に左右されない)。頭頂どうしの比にしないのは、アバターは頭が大きく目の高さの割合が人と違うことが多く、
    // そのぶん浮くため(手元のVRoidモデルで目/身長 = 0.91、人は 0.93 で、頭頂の比だと立って3.7cm浮いた)。
    // 自動なら、立ちモードは位置合わせのときの目の高さとの比、座りモードは1
    const realHeight = this.body.realHeight;
    const scale =
      realHeight && avatarEye
        ? avatarEye / (realHeight * HUMAN_EYE_RATIO)
        : !seated && avatarEye
          ? avatarEye / eyeHeight
          : 1;
    // 座りモードは、アバターの立った目の高さ(現実の長さに戻したもの)まで持ち上げる
    const heightOffset = seated
      ? Math.max(0, (avatarEye ?? DEFAULT_STANDING_EYE) / scale - eyeHeight)
      : 0;

    this.calibration = {
      origin: new THREE.Vector3(p.x, 0, p.z), // 高さはlocal-floorの床(0)を使う
      yaw,
      yawAngle,
      headRest: new THREE.Quaternion().copy(yaw).multiply(_q),
      scale,
      heightOffset,
    };
    const notes = [
      realHeight ? `身長${Math.round(realHeight * 100)}cmで${(scale * 100).toFixed(0)}%` : `身長を${(scale * 100).toFixed(0)}%に合わせました`,
    ];
    if (seated) notes.push(`座りモード: 目の高さを${Math.round(heightOffset * 100)}cm持ち上げています`);
    // 身長を選んだ立ちモードで、測った目の高さが合わないときは知らせる(床の高さか、身長の設定のずれ)
    if (realHeight && !seated && avatarEye) {
      const gap = eyeHeight * scale - avatarEye;
      if (Math.abs(gap) > EYE_MISMATCH_WARN) {
        notes.push(
          `目の高さが${Math.round(Math.abs(gap / scale) * 100)}cm${gap > 0 ? '高い' : '低い'}ようです。床の高さか身長の設定を確かめてください`,
        );
      }
    }
    this.onStatus?.(`位置を合わせました(今の向きが正面 / ${notes.join(' / ')})`);
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
    // ワイヤ = (現実 + 持ち上げ - 足元) を回して × 比。その逆: 足元から持ち上げぶん下げ、向きを戻し、1/比
    target.position.copy(this.calibration.origin);
    target.position.y -= this.calibration.heightOffset + this.body.heightShift;
    target.quaternion.setFromAxisAngle(UP, this.calibration.yawAngle);
    target.scale.setScalar(1 / this.calibration.scale);
    return true;
  }

  /** 位置合わせのときの足元(現実の床)。操作パネルを置く基準 */
  get floorOrigin(): THREE.Vector3 | null {
    return this.calibration?.origin ?? null;
  }

  /** XR空間の位置をワイヤ座標(足元が原点・正面+Z・身長補正済み)へ */
  private toWirePosition(p: DOMPointReadOnly, out: THREE.Vector3): THREE.Vector3 {
    const calibration = this.calibration!;
    return out
      .set(p.x, p.y + calibration.heightOffset + this.body.heightShift, p.z)
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

  /**
   * XRのフレームごとに呼ぶ。姿勢は毎フレーム作って手元のアバターに当て、
   * 配信中なら30Hzに間引いて送る(配信していなくても、手元のアバターは動く)
   */
  sendFrame(frame: XRFrame, refSpace: XRReferenceSpace, session: XRSession): void {
    if (!this.calibration) return;
    const now = performance.now();
    const viewer = frame.getViewerPose(refSpace);
    if (!viewer) return;
    // 前のフレームからの時間を 1/30秒 単位にしたもの(指の寄せ方をフレームの間隔によらず同じにする)
    const steps = Math.min(3, Math.max(0, (now - this.lastExpressionAt) / (1000 / 30)));
    const follow = 1 - (1 - CURL_FOLLOW) ** steps;

    // 頭は「開始時の姿勢からの差分」。開始時に単位元になる
    const headRestInverse = _restInverse.copy(this.calibration.headRest).invert();
    const head = this.toNode(viewer.transform, headRestInverse);
    // 目の位置から頭の骨の位置へ戻す(目までのずれを、頭の向きに合わせて回して引く)
    _eye
      .copy(this.avatarEye)
      .applyQuaternion(_headRot.set(head.rotation[0], head.rotation[1], head.rotation[2], head.rotation[3]));
    head.position = [
      head.position[0] - _eye.x,
      head.position[1] - _eye.y,
      head.position[2] - _eye.z,
    ] as Vec3;

    const hands: Record<'left' | 'right', PoseNode | null> = { left: null, right: null };
    const curls: Record<'left' | 'right', FingerCurls> = {
      left: RELAXED_CURLS,
      right: RELAXED_CURLS,
    };
    const spread = { left: 0.5, right: 0.5 };
    const gestures: Record<'left' | 'right', GestureReading> = { left: NEUTRAL, right: NEUTRAL };
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
        // 素手は指をそのまま送り、指の形から読んだジェスチャーは表情にだけ使う
        const fromHand = gestureFromCurls(reading.curls);
        gestures[side] = {
          gesture: this.stabilizers.hand[side].update(fromHand.gesture, now),
          weight: fromHand.weight,
        };
        continue;
      }

      this.handReader.forget(side);
      if (!source.gripSpace) continue;
      const pose = frame.getPose(source.gripSpace, refSpace);
      if (!pose) continue;
      _grip.copy(GRIP_TO_HAND[side]).multiply(WRIST_OFFSET[side]);
      hands[side] = this.toNode(pose.transform, null, _grip);
      // コントローラは、グリップ・トリガー・親指から VRChat のジェスチャーを読んで指の形を作る。
      // 視聴者は最後に届いた指を保持し続けるので、素手から持ち替えたときもここで必ず上書きされる
      const input = source.gamepad ? readController(source.gamepad) : null;
      if (input) {
        const read = gestureFromController(input);
        gestures[side] = {
          gesture: this.stabilizers.controller[side].update(read.gesture, now),
          weight: read.weight,
        };
        const target = gesturePose(gestures[side], input);
        const current = this.controllerCurls[side];
        for (let f = 0; f < 5; f++) current[f] = current[f]! + (target.curls[f]! - current[f]!) * follow;
        this.controllerSpread[side] += (target.spread - this.controllerSpread[side]) * follow;
      }
      curls[side] = [...this.controllerCurls[side]] as FingerCurls;
      spread[side] = this.controllerSpread[side];
    }

    // 表情: パネルで選んだ表情か、ジェスチャーに割り当てた表情
    const expressionValues = this.gestureMixer.update(gestures, (now - this.lastExpressionAt) / 1000);
    this.lastExpressionAt = now;
    for (const [name, value] of expressionValues) this.expressions.set(name, value);

    // コントローラが片方でも取れないときは、体側に下ろした位置で埋める
    const fallback = (sign: number): PoseNode => ({
      position: [sign * 0.21, Math.max(head.position[1] - 0.62, 0.1), 0.03] as Vec3,
      rotation: [0, 0, sign * -0.707, 0.707] as Quat,
    });

    const pose = {
      head,
      leftHand: hands.left ?? fallback(1),
      rightHand: hands.right ?? fallback(-1),
    };
    const fingers = {
      leftCurls: curls.left,
      rightCurls: curls.right,
      leftSpread: spread.left,
      rightSpread: spread.right,
    };
    // 座りモードでは体を送らない(座った腰・足を送ると、立たせたいアバターが座ってしまう)
    const body =
      this.mode === 'seated'
        ? null
        : readBody(frame as BodyFrame, refSpace, (p, out) => this.toWirePosition(p, out));
    this.latest = {
      pose,
      fingers,
      expressions: this.expressions.current,
      ...(body ? { body } : {}),
    };
    this.latestAt = now;

    // 配信中だけ、30Hzに間引いて送る
    if (!this.active || now - this.lastSentAt < SEND_INTERVAL_MS) return;
    this.lastSentAt = now;
    const packet: Omit<Packet, 'sequence' | 'timestamp'> = { pose };
    // 体は補間の要なので毎パケット送る(取れないフレームは送らず、視聴者側は頭からの推定に戻る)
    if (body) packet.body = body;
    if (this.publisher.packetIndex % FINGER_EVERY === 0) {
      packet.fingers = fingers;
      this.expressions.attachTo(packet, now);
    }
    this.publisher.send(packet, now);
  }

  /** 配信だけ止める(VRはそのまま。立ち位置の基準も残す) */
  disconnect(): void {
    this.connecting = null;
    this.publisher.close();
    this.onStatus?.('配信を停止しました(VRはそのままです)');
  }

  close(): void {
    this.connecting = null;
    this.publisher.close();
    this.calibration = null;
    this.latest = null;
    this.onStatus?.('HMD配信を停止しました');
  }
}

const _restInverse = new THREE.Quaternion();
const _eye = new THREE.Vector3();
const _headRot = new THREE.Quaternion();
const _noEyeOffset = new THREE.Vector3();
const _grip = new THREE.Quaternion();
