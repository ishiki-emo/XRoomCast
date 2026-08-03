/**
 * トランスポート層の抽象(実装仕様書 §5 Phase 2c)。
 * Phase 2bのWebSocket実装とPhase 2cのCloudflare Realtime SFU実装を
 * 差し替え可能にするため、2bの時点でこの抽象を入れておく。
 */
export interface Transport {
  /** §6形式のバイナリパケットを受信したときに呼ばれる */
  onPacket: ((bytes: Uint8Array) => void) | null;
  /** 接続状態の変化をUIへ通知する */
  onStatus: ((text: string, isError?: boolean) => void) | null;
  connect(): void;
  send(bytes: Uint8Array): void;
  close(): void;
}
