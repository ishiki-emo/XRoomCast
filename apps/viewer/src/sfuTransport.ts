/**
 * Cloudflare Realtime SFUトランスポート(実装仕様書 §5 Phase 2c)。
 * サブスクライバーセッションを確立し、パブリッシャー(ブリッジ)のDataChannelを購読する。
 * セッション作成はブリッジのプロキシAPI経由で行い、App Secretはブラウザに来ない。
 * DataChannelは一方向(publisher→subscribers)のため send() は何もしない。
 * 切断・失敗時は指数バックオフ(1s→最大16s)でセッションを張り直す。
 */
import type { Transport } from './transport';

const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 16000;

export class SfuTransport implements Transport {
  onPacket: ((bytes: Uint8Array) => void) | null = null;
  onStatus: ((text: string, isError?: boolean) => void) | null = null;

  private pc: RTCPeerConnection | null = null;
  private closedByUser = false;
  private retryCount = 0;
  private retryTimer: number | null = null;
  /** 世代カウンタ。古い接続試行のコールバックを無効化する */
  private generation = 0;

  constructor(private readonly baseUrl: string) {}

  connect(): void {
    this.closedByUser = false;
    void this.open();
  }

  private async apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
    }
    return data;
  }

  private async open(): Promise<void> {
    const generation = ++this.generation;
    this.pc?.close();
    this.pc = null;

    try {
      this.onStatus?.(`SFU接続中... ${this.baseUrl}`);
      const pc = new RTCPeerConnection({
        iceServers: [{ urls: CF_STUN_URL }],
        bundlePolicy: 'max-bundle',
      });
      this.pc = pc;

      // m=applicationセクションを作るためのダミーチャネル
      pc.createDataChannel('bootstrap');
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);

      const session = await this.apiPost('/api/sfu/sessions/new', { sdp: offer.sdp });
      await pc.setRemoteDescription({ type: 'answer', sdp: String(session.sdp) });

      const sub = await this.apiPost('/api/sfu/subscribe', { sessionId: session.sessionId });
      const channel = pc.createDataChannel(String(sub.name), {
        negotiated: true,
        id: Number(sub.id),
      });
      channel.binaryType = 'arraybuffer';

      channel.onopen = () => {
        if (generation !== this.generation) return;
        this.retryCount = 0;
        this.onStatus?.('SFU接続完了(DataChannel購読中)');
      };
      channel.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
          this.onPacket?.(new Uint8Array(event.data));
        }
      };
      channel.onclose = () => {
        if (generation !== this.generation) return;
        this.scheduleReconnect('DataChannelが閉じられました');
      };
      pc.onconnectionstatechange = () => {
        if (generation !== this.generation) return;
        if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
          this.scheduleReconnect(`WebRTC接続が${pc.connectionState}になりました`);
        }
      };
    } catch (error) {
      if (generation !== this.generation) return;
      this.scheduleReconnect(String(error));
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUser) return;
    this.pc?.close();
    this.pc = null;
    const delay = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** this.retryCount);
    this.retryCount += 1;
    this.onStatus?.(
      `SFU切断: ${reason}。${(delay / 1000).toFixed(0)}秒後に再接続します(${this.retryCount}回目)`,
      true,
    );
    this.retryTimer = window.setTimeout(() => void this.open(), delay);
  }

  /** DataChannelは一方向(publisher→subscribers)のためビューアからは送らない */
  send(): void {}

  close(): void {
    this.closedByUser = true;
    this.generation += 1;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pc?.close();
    this.pc = null;
    this.onStatus?.('SFU切断');
  }
}
