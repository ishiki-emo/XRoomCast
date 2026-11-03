/**
 * ブラウザからポーズを配信する土台(SFUへのパブリッシャー接続・席の登録・送信)。
 * HMD配信(hmdBroadcast.ts)とWebカメラ配信(webcamBroadcast.ts)が共有する。
 *
 * SFUへの publish 手順はブリッジ(apps/bridge/src/sfu.ts)と同じで、
 * App SecretはWorkerのプロキシ側にあるためブラウザには出てこない。
 */
import { encodePacket, type Packet } from '@xroomcast/protocol';
import type { AuthProvider } from '@xroomcast/sync';
import { withRoom } from '@xroomcast/sync';

const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const DATA_CHANNEL_NAME = 'pose';
/** パブリッシャー登録のハートビート(Worker側は15分で失効とみなす) */
const HEARTBEAT_MS = 4 * 60 * 1000;

export class PosePublisher {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private sessionId: string | null = null;
  private heartbeat: number | null = null;
  private sequence = 0;
  private startedAt = 0;

  constructor(
    private readonly room: string,
    private readonly auth: AuthProvider,
    /** 配信者名。席(slot)の割り当てとコンソールの自動席解決の鍵になる */
    private readonly pid: () => string,
    private readonly onStatus: (text: string) => void,
  ) {}

  get active(): boolean {
    return this.channel?.readyState === 'open';
  }

  private async api(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(withRoom(path, this.room), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await this.auth.headers()) },
      body: JSON.stringify(body),
    });
    const data = (await res.json()) as Record<string, unknown>;
    if (!res.ok) throw new Error(String(data.error ?? `${path} が失敗 (${res.status})`));
    return data;
  }

  /** SFUへパブリッシャーとして接続する(ブリッジと同じ手順) */
  async connect(): Promise<void> {
    this.onStatus('SFUへ接続中...');
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: CF_STUN_URL }],
      bundlePolicy: 'max-bundle',
    });
    this.pc = pc;

    // m=applicationセクションを作るためのダミーチャネル
    pc.createDataChannel('bootstrap');
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const session = await this.api('/api/sfu/sessions/new', { sdp: offer.sdp });
    this.sessionId = String(session.sessionId);
    await pc.setRemoteDescription({ type: 'answer', sdp: String(session.sdp) });

    const result = await this.api('/api/sfu/datachannels/new', {
      sessionId: this.sessionId,
      dataChannels: [{ location: 'local', dataChannelName: DATA_CHANNEL_NAME }],
    });
    const channels = result.dataChannels as { id: number }[] | undefined;
    const channelId = channels?.[0]?.id;
    if (channelId === undefined) throw new Error('DataChannel IDが取得できませんでした');

    const channel = pc.createDataChannel(DATA_CHANNEL_NAME, {
      negotiated: true,
      id: channelId,
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('DataChannelのopen待ちがタイムアウト')),
        15000,
      );
      channel.onopen = () => {
        clearTimeout(timer);
        resolve();
      };
      channel.onerror = () => {
        clearTimeout(timer);
        reject(new Error('DataChannelの接続に失敗しました'));
      };
    });
    this.channel = channel;

    await this.register();
    this.heartbeat = window.setInterval(() => void this.register(), HEARTBEAT_MS);
    this.startedAt = performance.now();
    this.sequence = 0;
  }

  /** 視聴者が購読できるよう、自分のセッションIDを登録する */
  private async register(): Promise<void> {
    if (!this.sessionId) return;
    // pid はブリッジと席を分ける・再接続で同じ席を保つための固定ID。
    // コンソールの配信者名と同じ値を使う(自動席解決がそれを前提にする)
    await this.api('/api/sfu/publisher', { sessionId: this.sessionId, pid: this.pid() });
  }

  /** 何パケット目か(指や表情を間引く判定に使う) */
  get packetIndex(): number {
    return this.sequence;
  }

  /** 連番と時刻を付けて送る */
  send(packet: Omit<Packet, 'sequence' | 'timestamp'>, now = performance.now()): void {
    if (!this.channel) return;
    const bytes = encodePacket({
      ...packet,
      sequence: this.sequence & 0xffff,
      timestamp: Math.round(now - this.startedAt) >>> 0,
    });
    this.sequence++;
    // encodePacketの戻りはUint8Array<ArrayBufferLike>。sendはArrayBufferを要求する
    this.channel.send(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
  }

  close(): void {
    if (this.heartbeat !== null) {
      window.clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    // 明示的な退席(席のアバター・音声もサーバー側で片付く)。
    // 送れなくても15分で自動失効する
    if (this.sessionId) {
      void this.api('/api/sfu/publisher', { sessionId: null, pid: this.pid() }).catch(() => {});
    }
    this.channel = null;
    this.pc?.close();
    this.pc = null;
    this.sessionId = null;
  }
}
