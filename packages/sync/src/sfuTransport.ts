/**
 * Cloudflare Realtime SFUトランスポート(実装仕様書 §5 Phase 2c)。
 * サブスクライバーセッションを確立し、パブリッシャー(ブリッジ)のDataChannelを購読する。
 * セッション作成はブリッジのプロキシAPI経由で行い、App Secretはブラウザに来ない。
 * DataChannelは一方向(publisher→subscribers)のため send() は何もしない。
 * 切断・失敗時は指数バックオフ(1s→最大16s)でセッションを張り直す。
 */
import { anonymousAuth, withAuth, type AuthProvider } from './auth';
import { DEFAULT_ROOM } from './room';
import type { Transport } from './transport';

const CF_STUN_URL = 'stun:stun.cloudflare.com:3478';
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 16000;
/**
 * 無受信ウォッチドッグ。ブリッジが再起動するとパブリッシャーセッションが変わり、
 * 旧セッションを購読中のDataChannelは閉じられないまま無音になるため、
 * 一定時間パケットが来なければセッションを張り直す
 */
const STALE_TIMEOUT_MS = 10000;

/** 音声トラック購読の確認間隔(配信者が後から音声を開始しても拾えるように) */
const AUDIO_CHECK_INTERVAL_MS = 30000;

export class SfuTransport implements Transport {
  onPacket: ((bytes: Uint8Array) => void) | null = null;
  onStatus: ((text: string, isError?: boolean) => void) | null = null;
  /** 配信者の音声トラックを購読できたとき(track)と配信終了時(null)に呼ばれる */
  onAudioTrack: ((track: MediaStreamTrack | null) => void) | null = null;

  private pc: RTCPeerConnection | null = null;
  private closedByUser = false;
  private retryCount = 0;
  private retryTimer: number | null = null;
  private watchdogTimer: number | null = null;
  private lastPacketAt = 0;
  private audioTimer: number | null = null;
  private audioSubscribedSession: string | null = null;
  private mySessionId: string | null = null;
  /** 世代カウンタ。古い接続試行のコールバックを無効化する */
  private generation = 0;

  constructor(
    private readonly baseUrl: string,
    /** 購読するルーム。Worker側はパブリッシャーをルームごとに保持する */
    private readonly room: string = DEFAULT_ROOM,
    /** 視聴の資格情報。Worker側が視聴認可を有効にしている場合のみ必要 */
    private readonly auth: AuthProvider = anonymousAuth,
  ) {}

  connect(): void {
    this.closedByUser = false;
    void this.open();
  }

  private async apiPost(path: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.baseUrl}${withAuth(path, this.room, this.auth)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await this.auth.headers()) },
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
      this.mySessionId = String(session.sessionId);
      this.audioSubscribedSession = null;
      await pc.setRemoteDescription({ type: 'answer', sdp: String(session.sdp) });

      // 配信者の音声トラックが届いたら通知する
      pc.ontrack = (event) => {
        if (generation !== this.generation) return;
        if (event.track.kind === 'audio') this.onAudioTrack?.(event.track);
      };

      const sub = await this.apiPost('/api/sfu/subscribe', { sessionId: session.sessionId });
      const channel = pc.createDataChannel(String(sub.name), {
        negotiated: true,
        id: Number(sub.id),
      });
      channel.binaryType = 'arraybuffer';

      channel.onopen = () => {
        if (generation !== this.generation) return;
        this.retryCount = 0;
        this.lastPacketAt = performance.now();
        this.startWatchdog(generation);
        this.startAudioCheck(generation);
        this.onStatus?.('SFU接続完了(DataChannel購読中)');
      };
      channel.onmessage = (event) => {
        this.lastPacketAt = performance.now();
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

  /**
   * 音声トラックの購読。ステータスAPIで音声パブリッシャーの有無を確認し、
   * 居れば同じPeerConnectionにトラックを追加購読する(サーバー主導の再ネゴシエーション)。
   * 配信者が途中から音声を始めるケースに備えて定期的に確認する
   */
  private startAudioCheck(generation: number): void {
    this.stopAudioCheck();
    const check = async (): Promise<void> => {
      if (generation !== this.generation || !this.pc || !this.mySessionId) return;
      try {
        const res = await fetch(
          `${this.baseUrl}${withAuth('/api/sfu/status', this.room, this.auth)}`,
          { headers: await this.auth.headers() },
        );
        const status = (await res.json()) as {
          audio: { sessionId: string; trackName: string } | null;
        };
        const audio = status.audio;
        if (!audio) {
          // 配信者が音声を止めた(登録解除された)
          if (this.audioSubscribedSession !== null) {
            this.audioSubscribedSession = null;
            this.onAudioTrack?.(null);
          }
          return;
        }
        if (audio.sessionId === this.audioSubscribedSession) return;
        if (generation !== this.generation || !this.pc) return;

        const result = await this.apiPost('/api/sfu/tracks/new', {
          sessionId: this.mySessionId,
          tracks: [{ location: 'remote', sessionId: audio.sessionId, trackName: audio.trackName }],
        });
        const desc = result.sessionDescription as { type: string; sdp: string } | undefined;
        if (result.requiresImmediateRenegotiation && desc) {
          await this.pc.setRemoteDescription({ type: 'offer', sdp: desc.sdp });
          const answer = await this.pc.createAnswer();
          await this.pc.setLocalDescription(answer);
          await this.apiPost('/api/sfu/renegotiate', { sessionId: this.mySessionId, sdp: answer.sdp });
        }
        this.audioSubscribedSession = audio.sessionId;
      } catch (error) {
        console.warn('[sfu] 音声トラックの購読確認に失敗:', error);
      }
    };
    void check();
    this.audioTimer = window.setInterval(() => void check(), AUDIO_CHECK_INTERVAL_MS);
  }

  private stopAudioCheck(): void {
    if (this.audioTimer !== null) {
      window.clearInterval(this.audioTimer);
      this.audioTimer = null;
    }
  }

  private startWatchdog(generation: number): void {
    this.stopWatchdog();
    this.watchdogTimer = window.setInterval(() => {
      if (generation !== this.generation) {
        this.stopWatchdog();
        return;
      }
      if (performance.now() - this.lastPacketAt > STALE_TIMEOUT_MS) {
        this.stopWatchdog();
        this.scheduleReconnect(`${STALE_TIMEOUT_MS / 1000}秒間パケット未受信(配信元の再起動の可能性)`);
      }
    }, 2000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUser) return;
    this.stopWatchdog();
    this.stopAudioCheck();
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
    this.stopWatchdog();
    this.stopAudioCheck();
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pc?.close();
    this.pc = null;
    this.onStatus?.('SFU切断');
  }
}
