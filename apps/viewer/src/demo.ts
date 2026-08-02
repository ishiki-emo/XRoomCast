/**
 * デモ再生モード(実装仕様書 §5 Phase 2a)。
 * ダミーモーションを30Hzで生成し、実経路と同じくエンコード→(ランダムドロップ)→
 * デコードを通してからジッタバッファへ流し込む。
 */
import { decodePacket, encodePacket } from '@xroomcast/protocol';
import { dummyPacketAt, POSE_INTERVAL_MS } from '@xroomcast/fixtures';
import { PoseStreamPlayer } from './poseStream';

export class DemoController {
  active = false;
  /** パケットドロップ率(0〜1)。受け入れ条件の欠落テスト用 */
  dropRate = 0;

  private currentPlayer = new PoseStreamPlayer();
  private timer: number | null = null;
  private sequence = 0;
  private startTime = 0;

  get player(): PoseStreamPlayer {
    return this.currentPlayer;
  }

  start(): void {
    this.stop();
    this.active = true;
    this.sequence = 0;
    this.startTime = performance.now();
    this.currentPlayer = new PoseStreamPlayer();
    this.timer = window.setInterval(() => this.tick(), POSE_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    this.active = false;
  }

  private tick(): void {
    const now = performance.now();
    const packet = dummyPacketAt(now - this.startTime, this.sequence++);
    // 実経路(bridge→viewer)と同じシリアライズを通す
    const bytes = encodePacket(packet);
    if (Math.random() < this.dropRate) return; // ネットワーク欠落のシミュレーション
    this.currentPlayer.push(decodePacket(bytes), now);
  }
}
