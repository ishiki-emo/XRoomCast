/**
 * ブラウザからの配信(Webカメラ・HMD)で表情を送る仕組み。ブリッジ(apps/bridge)と同じ約束で送る:
 *
 * - 表情は名前ではなく番号で送り、番号と名前の対応(辞書)を別に送る
 * - SFUは一方向で、途中から見始めた人に接続時に送ることができないので、
 *   5秒ごとに辞書と全表情を送り直す。その間は、変わった表情だけを送る
 * - 名前はセッション中に増やすだけで減らさない(使わなくなった表情も0を送り続け、
 *   視聴側で出たままにしない)。名前が増えたら、すぐに辞書を送り直す
 */
import type { ExpressionEntry, Packet } from '@xroomcast/protocol';

/** 辞書と全表情の再送間隔 */
const KEYFRAME_MS = 5000;
/** 1パケットの表情の上限(ワイヤ形式の制約) */
const MAX_NAMES = 255;

export class ExpressionChannel {
  private readonly names: string[] = [];
  private readonly values = new Map<string, number>();
  private readonly sent = new Map<string, number>();
  private lastKeyframeAt = -Infinity;

  constructor(initialNames: readonly string[] = []) {
    for (const name of initialNames) this.ensure(name);
  }

  /** 送る表情の名前(番号はこの並び順) */
  get expressionNames(): readonly string[] {
    return this.names;
  }

  /** いまの値(プレビューへ直接当てるのに使う) */
  get current(): ReadonlyMap<string, number> {
    return this.values;
  }

  /** 名前を足す。足せなければ false(上限) */
  ensure(name: string): boolean {
    if (this.names.includes(name)) return true;
    if (this.names.length >= MAX_NAMES) return false;
    this.names.push(name);
    this.values.set(name, 0);
    // 視聴側が新しい名前を知らないまま値だけ届かないよう、すぐに辞書を送り直す
    this.lastKeyframeAt = -Infinity;
    return true;
  }

  set(name: string, value: number): void {
    if (!this.ensure(name)) return;
    this.values.set(name, Math.min(1, Math.max(0, value)));
  }

  /** 送り始めるとき(新しいセッション)。次のパケットで辞書と全表情を送る */
  restart(): void {
    this.lastKeyframeAt = -Infinity;
    this.sent.clear();
  }

  /** パケットに辞書(必要なとき)と、変わった表情を載せる */
  attachTo(packet: Omit<Packet, 'sequence' | 'timestamp'>, now: number): void {
    if (now - this.lastKeyframeAt >= KEYFRAME_MS) {
      this.lastKeyframeAt = now;
      packet.dictionary = this.names.map((name, id) => ({ id, name }));
      this.sent.clear();
    }
    const entries: ExpressionEntry[] = [];
    this.names.forEach((name, id) => {
      const value = this.values.get(name) ?? 0;
      const sent = this.sent.get(name);
      if (sent !== undefined && Math.abs(sent - value) < 1 / 255) return;
      this.sent.set(name, value);
      entries.push({ id, value });
    });
    if (entries.length > 0) packet.expressions = entries;
  }
}
