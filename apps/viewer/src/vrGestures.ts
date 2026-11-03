/**
 * HMD配信のハンドジェスチャー(VRChat準拠)。
 *
 * VRChat の標準のハンドポーズ7種類と、そのどれでもない「ニュートラル」を判定する。
 * 番号は VRChat のアバターの GestureLeft / GestureRight と同じ(0〜7)。
 *
 * - コントローラ: グリップ(中指)・トリガー(人差し指)・親指の状態から判定する。
 *   対応は VRChat の Oculus Touch の表(docs.vrchat.com/docs/touch)に合わせてある
 * - 素手: 指の曲がり具合から、同じ7種類を判定する
 *
 * 判定したジェスチャーで指の形(ハンドポーズ)を決め、表情の切り替え(gestureExpressions.ts)にも使う
 */
import type { FingerCurls } from '@xroomcast/protocol';

export const GESTURE = {
  neutral: 0,
  fist: 1,
  handOpen: 2,
  fingerPoint: 3,
  victory: 4,
  rockNRoll: 5,
  handGun: 6,
  thumbsUp: 7,
} as const;

export type Gesture = (typeof GESTURE)[keyof typeof GESTURE];

/** 表情を割り当てられるジェスチャー(ニュートラル以外)と、配信者ページでの表示 */
export const GESTURE_INFO: readonly { gesture: Gesture; label: string; howTo: string }[] = [
  {
    gesture: GESTURE.fist,
    label: '✊ グー(Fist)',
    howTo: 'グリップを握り、トリガーを引き、親指をボタンに乗せる',
  },
  {
    gesture: GESTURE.handOpen,
    label: '🖐 パー(Open)',
    howTo: 'グリップを離し、トリガーから指を離し、親指を浮かせる',
  },
  {
    gesture: GESTURE.fingerPoint,
    label: '☝ 指差し(Point)',
    howTo: 'グリップを握り、トリガーから指を離し、親指をボタンに乗せる',
  },
  {
    gesture: GESTURE.victory,
    label: '✌ ピース(Victory)',
    howTo: 'グリップを離し、トリガーから指を離し、親指をボタンに乗せる',
  },
  {
    gesture: GESTURE.rockNRoll,
    label: '🤘 ロック(RockNRoll)',
    howTo: 'グリップを離し、トリガーを引き、親指をボタンに乗せる',
  },
  {
    gesture: GESTURE.handGun,
    label: '🔫 指鉄砲(HandGun)',
    howTo: 'グリップを握り、トリガーから指を離し、親指を浮かせる',
  },
  {
    gesture: GESTURE.thumbsUp,
    label: '👍 いいね(ThumbsUp)',
    howTo: 'グリップを握り、トリガーに指を触れるだけにして、親指を浮かせる',
  },
];

export interface GestureReading {
  gesture: Gesture;
  /** トリガーの引き具合(0..1)。VRChat の GestureWeight と同じで、グーの表情の強さに使う */
  weight: number;
}

/** トリガーを「引いている」とみなす値 */
const TRIGGER_PULLED = 0.5;
/** グリップを「握っている」とみなす値 */
const GRIP_PRESSED = 0.5;

/** コントローラの入力(WebXR の xr-standard の並び: 0=トリガー、1=グリップ、2以降=タッチパッド・スティック・ボタン) */
export interface ControllerInput {
  trigger: number;
  triggerTouched: boolean;
  grip: number;
  /** 親指がボタン・スティック・サムレストのどれかに触れているか */
  thumbDown: boolean;
}

export function readController(gamepad: Gamepad): ControllerInput {
  const buttons = gamepad.buttons;
  const trigger = buttons[0];
  const grip = buttons[1];
  let thumbDown = false;
  for (let i = 2; i < buttons.length; i++) {
    const button = buttons[i]!;
    if (button.touched || button.pressed) {
      thumbDown = true;
      break;
    }
  }
  return {
    trigger: trigger?.value ?? 0,
    // 触れたことを取れないコントローラでも、引けば触れていることにする(VRChat と同じ)
    triggerTouched: Boolean(trigger?.touched || trigger?.pressed || (trigger?.value ?? 0) > 0.05),
    grip: grip?.value ?? (grip?.pressed ? 1 : 0),
    thumbDown,
  };
}

/** コントローラの入力から、VRChat の Oculus Touch の表のとおりにジェスチャーを判定する */
export function gestureFromController(input: ControllerInput): GestureReading {
  const grip = input.grip >= GRIP_PRESSED;
  const pulled = input.trigger >= TRIGGER_PULLED;
  const off = !input.triggerTouched;
  const thumb = input.thumbDown;
  const weight = input.trigger;
  const is = (gesture: Gesture): GestureReading => ({ gesture, weight });
  if (grip && pulled && thumb) return is(GESTURE.fist);
  if (!grip && off && !thumb) return is(GESTURE.handOpen);
  if (grip && off && thumb) return is(GESTURE.fingerPoint);
  if (grip && !off && !pulled && !thumb) return is(GESTURE.thumbsUp);
  if (!grip && off && thumb) return is(GESTURE.victory);
  if (grip && off && !thumb) return is(GESTURE.handGun);
  if (!grip && pulled && thumb) return is(GESTURE.rockNRoll);
  return is(GESTURE.neutral);
}

/** 指が伸びている・曲がっているとみなす曲がり具合(0..1)。親指は付け根の折れが残るので別の値 */
const EXTENDED = 0.35;
const CURLED = 0.55;
const THUMB_EXTENDED = 0.3;
const THUMB_CURLED = 0.5;

/** 素手の指の曲がり具合から、同じ7種類を判定する([親指, 人差し指, 中指, 薬指, 小指]) */
export function gestureFromCurls(curls: FingerCurls): GestureReading {
  const [thumb, index, middle, ring, pinky] = curls;
  const ext = (c: number) => c < EXTENDED;
  const cur = (c: number) => c > CURLED;
  const thumbExt = thumb < THUMB_EXTENDED;
  const thumbCur = thumb > THUMB_CURLED;
  const is = (gesture: Gesture, weight = 1): GestureReading => ({ gesture, weight });
  // 中指・薬指・小指の組み合わせで大きく分け、人差し指と親指で決める
  if (cur(middle) && cur(ring) && cur(pinky)) {
    if (cur(index)) {
      if (thumbExt) return is(GESTURE.thumbsUp);
      // グーの強さは、人差し指の握り込み具合(コントローラのトリガーの代わり)
      if (thumbCur) return is(GESTURE.fist, Math.min(1, (index - CURLED) / (1 - CURLED) + 0.5));
    }
    if (ext(index)) {
      if (thumbExt) return is(GESTURE.handGun);
      if (thumbCur) return is(GESTURE.fingerPoint);
    }
  }
  if (ext(index) && ext(middle) && cur(ring) && cur(pinky)) return is(GESTURE.victory);
  if (ext(index) && cur(middle) && cur(ring) && ext(pinky)) return is(GESTURE.rockNRoll);
  if (ext(index) && ext(middle) && ext(ring) && ext(pinky)) return is(GESTURE.handOpen);
  return is(GESTURE.neutral);
}

/**
 * 判定のぶれを抑える。同じジェスチャーが一定時間続いたときだけ切り替える
 * (指の位置が境目にあると、フレームごとに判定が入れ替わって表情が点滅するため)。
 * フレーム数ではなく時間で数える(ヘッドセットの表示は72〜120回/秒と端末で違うため)
 */
export class GestureStabilizer {
  private current: Gesture = GESTURE.neutral;
  private candidate: Gesture = GESTURE.neutral;
  private since = 0;

  constructor(private readonly holdMs = 120) {}

  update(next: Gesture, now: number): Gesture {
    if (next === this.current) {
      this.candidate = next;
      return this.current;
    }
    if (next !== this.candidate) {
      this.candidate = next;
      this.since = now;
    }
    if (now - this.since >= this.holdMs) this.current = next;
    return this.current;
  }

  reset(): void {
    this.current = this.candidate = GESTURE.neutral;
  }
}

/**
 * ジェスチャーごとの指の形([親指, 人差し指, 中指, 薬指, 小指]と開き具合)。
 * ニュートラルは決まった形にせず、トリガー・グリップの握り具合に合わせて指を曲げる
 * (コントローラを握っている手が、そのまま自然に見えるように)
 */
export function gesturePose(
  reading: GestureReading,
  input: ControllerInput,
): { curls: FingerCurls; spread: number } {
  const pose = (curls: FingerCurls, spread = 0.5) => ({ curls, spread });
  switch (reading.gesture) {
    case GESTURE.fist: {
      // グーはトリガーの引き具合で握りの強さが変わる
      const w = 0.7 + 0.3 * reading.weight;
      return pose([w, w, w, w, w], 0.3);
    }
    case GESTURE.handOpen:
      return pose([0, 0, 0, 0, 0], 1);
    case GESTURE.fingerPoint:
      return pose([0.9, 0, 1, 1, 1], 0.4);
    case GESTURE.victory:
      return pose([1, 0, 0, 1, 1], 1);
    case GESTURE.rockNRoll:
      return pose([0.9, 0, 1, 1, 0], 1);
    case GESTURE.handGun:
      return pose([0, 0, 1, 1, 1], 0.4);
    case GESTURE.thumbsUp:
      return pose([0, 1, 1, 1, 1], 0.3);
    default:
      return pose(
        [
          input.thumbDown ? 0.45 : 0.15,
          0.15 + (input.triggerTouched ? 0.15 : 0) + 0.6 * input.trigger,
          0.2 + 0.7 * input.grip,
          0.2 + 0.7 * input.grip,
          0.2 + 0.7 * input.grip,
        ],
        0.5,
      );
  }
}
