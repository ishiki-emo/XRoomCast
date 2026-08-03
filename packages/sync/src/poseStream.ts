/**
 * ジッタバッファ付きポーズストリーム再生(実装仕様書 §5 Phase 2a パイプライン1)。
 * 受信パケットをタイムスタンプ基準で目標遅延100msの位置で補間再生する。
 * 位置はlerp、回転はslerp。表情・手指は再生時刻までのイベントを畳み込んで保持する。
 */
import type {
  ExpressionEntry,
  FingerSection,
  Packet,
  PoseNode,
  PoseSection,
  Vec3,
} from '@xroomcast/protocol';
import { slerpQuat } from './quaternion';

export const TARGET_DELAY_MS = 100;
/** 受信タイムスタンプがローカル再生クロックからこれ以上ずれたらストリーム再開とみなす */
const CLOCK_RESET_THRESHOLD_MS = 3000;

export interface SampledFrame {
  pose?: PoseSection;
  /** 表情名 → 値。辞書未受信のIDは含まれない */
  expressions?: ReadonlyMap<string, number>;
  fingers?: FingerSection;
}

interface Timed<T> {
  timestamp: number;
  data: T;
}

function insertByTimestamp<T>(list: Timed<T>[], item: Timed<T>): void {
  let i = list.length;
  while (i > 0 && list[i - 1]!.timestamp > item.timestamp) i--;
  list.splice(i, 0, item);
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

function interpolateNode(a: PoseNode, b: PoseNode, t: number): PoseNode {
  return {
    position: lerpVec3(a.position, b.position, t),
    rotation: slerpQuat(a.rotation, b.rotation, t),
  };
}

export class PoseStreamPlayer {
  private poseEvents: Timed<PoseSection>[] = [];
  private expressionEvents: Timed<ExpressionEntry[]>[] = [];
  private fingerEvents: Timed<FingerSection>[] = [];
  private dictionary = new Map<number, string>();
  private expressionState = new Map<string, number>();
  private currentFingers: FingerSection | undefined;
  /** 送信側タイムスタンプ − ローカル時刻。最初のパケットで確定 */
  private clockOffset: number | null = null;

  push(packet: Packet, localNowMs: number): void {
    // 送信側の再起動などでクロックが不連続になったら、キューを捨てて仕切り直す。
    // これを怠ると旧ストリーム最後のパケットがバッファに残り、
    // 新ストリームのパケットがすべて「過去」扱いになって再生が凍結する
    if (
      this.clockOffset !== null &&
      Math.abs(packet.timestamp - (localNowMs + this.clockOffset)) > CLOCK_RESET_THRESHOLD_MS
    ) {
      console.warn('[poseStream] タイムスタンプの不連続を検出。ストリームを仕切り直します');
      this.poseEvents.length = 0;
      this.expressionEvents.length = 0;
      this.fingerEvents.length = 0;
      this.clockOffset = null;
    }
    if (this.clockOffset === null) {
      this.clockOffset = packet.timestamp - localNowMs;
    }
    if (packet.dictionary) {
      for (const e of packet.dictionary) this.dictionary.set(e.id, e.name);
    }
    if (packet.pose) {
      insertByTimestamp(this.poseEvents, { timestamp: packet.timestamp, data: packet.pose });
    }
    if (packet.expressions) {
      insertByTimestamp(this.expressionEvents, {
        timestamp: packet.timestamp,
        data: packet.expressions,
      });
    }
    if (packet.fingers) {
      insertByTimestamp(this.fingerEvents, { timestamp: packet.timestamp, data: packet.fingers });
    }
  }

  sample(localNowMs: number): SampledFrame {
    if (this.clockOffset === null) return {};
    const playTs = localNowMs + this.clockOffset - TARGET_DELAY_MS;

    // 表情: 再生時刻までのイベントを状態へ畳み込む(デルタ方式対応)。
    // 辞書未受信のIDは無視する(仕様書 §5 Phase 2b)
    while (this.expressionEvents.length > 0 && this.expressionEvents[0]!.timestamp <= playTs) {
      const event = this.expressionEvents.shift()!;
      for (const entry of event.data) {
        const name = this.dictionary.get(entry.id);
        if (name !== undefined) this.expressionState.set(name, entry.value);
      }
    }

    // 手指: 再生時刻以前の最新値を保持(15Hz送信なので保持で十分滑らか)
    while (this.fingerEvents.length > 0 && this.fingerEvents[0]!.timestamp <= playTs) {
      this.currentFingers = this.fingerEvents.shift()!.data;
    }

    // ポーズ: 再生時刻を挟む2パケットを補間。挟めない場合は端でクランプ(外挿しない)
    while (this.poseEvents.length >= 2 && this.poseEvents[1]!.timestamp <= playTs) {
      this.poseEvents.shift();
    }
    let pose: PoseSection | undefined;
    if (this.poseEvents.length === 1 || (this.poseEvents.length > 0 && playTs <= this.poseEvents[0]!.timestamp)) {
      pose = this.poseEvents[0]!.data;
    } else if (this.poseEvents.length >= 2) {
      const prev = this.poseEvents[0]!;
      const next = this.poseEvents[1]!;
      const t = (playTs - prev.timestamp) / (next.timestamp - prev.timestamp);
      pose = {
        head: interpolateNode(prev.data.head, next.data.head, t),
        leftHand: interpolateNode(prev.data.leftHand, next.data.leftHand, t),
        rightHand: interpolateNode(prev.data.rightHand, next.data.rightHand, t),
      };
    }

    return {
      pose,
      expressions: this.expressionState.size > 0 ? this.expressionState : undefined,
      fingers: this.currentFingers,
    };
  }
}
