/**
 * Cloudflare Realtime SFU(Calls API)連携(実装仕様書 §5 Phase 2c)。
 * - SfuApi: REST APIクライアント。App Secretはここ(ブリッジ)以外に出さない
 * - SfuPublisher: ブリッジ側のパブリッシャーセッション。node-datachannelの
 *   WebRTCポリフィルでDataChannel(一方向: publisher→subscribers)を張る
 * 手順は公式 cloudflare/realtime-examples の echo-datachannels サンプルに準拠。
 */
import { RTCPeerConnection } from 'node-datachannel/polyfill';

const API_BASE = 'https://rtc.live.cloudflare.com/v1/apps';
export const DATA_CHANNEL_NAME = 'pose';
export const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';

export interface SfuConfig {
  appId: string;
  appSecret: string;
}

interface NewSessionResponse {
  sessionId: string;
  sessionDescription: { type: string; sdp: string };
}

interface NewDataChannelsResponse {
  dataChannels: { id: number; dataChannelName: string }[];
}

export class SfuApi {
  constructor(private readonly config: SfuConfig) {}

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API_BASE}/${this.config.appId}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.appSecret}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      throw new Error(`Cloudflare API ${path} が失敗: ${res.status} ${await res.text()}`);
    }
    return (await res.json()) as T;
  }

  newSession(offerSdp: string): Promise<NewSessionResponse> {
    return this.post('/sessions/new', {
      sessionDescription: { type: 'offer', sdp: offerSdp },
    });
  }

  newDataChannels(
    sessionId: string,
    dataChannels: { location: 'local' | 'remote'; dataChannelName: string; sessionId?: string }[],
  ): Promise<NewDataChannelsResponse> {
    return this.post(`/sessions/${sessionId}/datachannels/new`, { dataChannels });
  }
}

export class SfuPublisher {
  sessionId: string | null = null;
  /** 接続(再接続含む)が完了しsessionIdが確定するたびに呼ばれる */
  onConnected: (() => void) | null = null;
  private pc: InstanceType<typeof RTCPeerConnection> | null = null;
  private channel: ReturnType<InstanceType<typeof RTCPeerConnection>['createDataChannel']> | null =
    null;
  private closed = false;

  constructor(private readonly api: SfuApi) {}

  get ready(): boolean {
    return this.channel?.readyState === 'open';
  }

  /** 接続に成功するまで指数バックオフでリトライし続ける */
  async connectWithRetry(): Promise<void> {
    let attempt = 0;
    while (!this.closed) {
      try {
        await this.connect();
        console.log(`[sfu] パブリッシャー接続完了: sessionId=${this.sessionId}`);
        this.onConnected?.();
        return;
      } catch (error) {
        const delay = Math.min(30000, 2000 * 2 ** attempt);
        attempt += 1;
        console.error(`[sfu] パブリッシャー接続失敗(${(delay / 1000).toFixed(0)}秒後に再試行):`, error);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  private async connect(): Promise<void> {
    this.pc?.close();
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: CF_STUN_URL }],
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;

    // m=applicationセクションを作るためのダミーチャネル(echo-datachannelsと同じ手順)
    pc.createDataChannel('bootstrap');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const session = await this.api.newSession(pc.localDescription!.sdp);
    this.sessionId = session.sessionId;
    await pc.setRemoteDescription({
      type: 'answer',
      sdp: session.sessionDescription.sdp,
    });

    const result = await this.api.newDataChannels(session.sessionId, [
      { location: 'local', dataChannelName: DATA_CHANNEL_NAME },
    ]);
    const channelId = result.dataChannels[0]?.id;
    if (channelId === undefined) {
      throw new Error('DataChannelのIDが取得できませんでした');
    }

    const channel = pc.createDataChannel(DATA_CHANNEL_NAME, {
      negotiated: true,
      id: channelId,
    });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('DataChannelのopen待ちがタイムアウト')), 15000);
      channel.onopen = () => {
        clearTimeout(timeout);
        resolve();
      };
      channel.onerror = (event) => {
        clearTimeout(timeout);
        reject(new Error(`DataChannelエラー: ${String(event)}`));
      };
    });
    channel.onclose = () => {
      this.channel = null;
      if (!this.closed) {
        console.warn('[sfu] DataChannelが切断されました。再接続します');
        void this.connectWithRetry();
      }
    };
    this.channel = channel;
  }

  send(bytes: Uint8Array): void {
    if (this.channel?.readyState === 'open') {
      this.channel.send(bytes);
    }
  }

  close(): void {
    this.closed = true;
    this.pc?.close();
  }
}
