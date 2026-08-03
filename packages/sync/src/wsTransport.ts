/**
 * WebSocketトランスポート(実装仕様書 §5 Phase 2b)。
 * 切断時は指数バックオフ(0.5s→1→2→4→最大8s)で自動再接続する。
 * close()による明示的な切断では再接続しない。
 */
import type { Transport } from './transport';

const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 8000;

export class WebSocketTransport implements Transport {
  onPacket: ((bytes: Uint8Array) => void) | null = null;
  onStatus: ((text: string, isError?: boolean) => void) | null = null;

  private ws: WebSocket | null = null;
  private closedByUser = false;
  private retryCount = 0;
  private retryTimer: number | null = null;

  constructor(private readonly url: string) {}

  connect(): void {
    this.closedByUser = false;
    this.open();
  }

  private open(): void {
    this.onStatus?.(`WebSocket接続中... ${this.url}`);
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.url);
    } catch (error) {
      this.onStatus?.(`WebSocket URLが不正です: ${String(error)}`, true);
      return;
    }
    this.ws = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      this.retryCount = 0;
      this.onStatus?.(`WebSocket接続完了: ${this.url}`);
    };

    ws.onmessage = (event) => {
      if (event.data instanceof ArrayBuffer) {
        this.onPacket?.(new Uint8Array(event.data));
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closedByUser) {
        this.onStatus?.('WebSocket切断');
        return;
      }
      const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.retryCount);
      this.retryCount += 1;
      this.onStatus?.(`WebSocket切断。${(delay / 1000).toFixed(1)}秒後に再接続します(${this.retryCount}回目)`, true);
      this.retryTimer = window.setTimeout(() => this.open(), delay);
    };

    // 接続失敗の詳細はoncloseで扱う(onerrorのイベントには情報がない)
    ws.onerror = () => {};
  }

  send(bytes: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  close(): void {
    this.closedByUser = true;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.ws?.close();
    this.ws = null;
  }
}
