/**
 * Cloudflare Realtime SFUトランスポート(実装仕様書 §5 Phase 2c)。
 * サブスクライバーセッションを確立し、パブリッシャー(ブリッジ)のDataChannelを購読する。
 * セッション作成はブリッジのプロキシAPI経由で行い、App Secretはブラウザに来ない。
 * DataChannelは一方向(publisher→subscribers)のため send() は何もしない。
 * 切断・失敗時は指数バックオフ(1s→最大16s)でセッションを張り直す。
 *
 * セッションの作り直しは**高価**である点に注意。1回につきWorkerへ2リクエスト、
 * うち sessions/new はCloudflare Realtime APIへの発信(サブリクエスト)を伴い、
 * 実測で1回あたり約500msかかる。したがって「モーションが届かない」だけで
 * 安易に張り直してはいけない。配信者が居ない・トラッキングが止まっている時間は
 * 常態であり、そこで作り直しを繰り返すと無料枠の1日10万リクエストに達する。
 * 判定は状態APIで行う(KV読みのみでサブリクエストが出ない)。
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
 * 一定時間パケットが来なければ**状態APIで様子を確認する**(すぐには張り直さない)
 */
const STALE_TIMEOUT_MS = 10000;

/**
 * 無受信が続いている間の状態確認の間隔。
 * この経路はKV読みだけなのでCloudflare APIへの発信は発生しない。
 * ただしタブを開きっぱなしにされると積み上がるため、変化が無い限り
 * 上限まで倍々に伸ばす(タブが表示に戻ったら即座に確認して間隔も戻す)
 */
const IDLE_POLL_MS = 15000;
const IDLE_POLL_MAX_MS = 120000;

/**
 * 配信元が変わっていなくても、これだけ無受信が続いたら一度は張り直す。
 * DataChannelが実際に死んでいて、かつパブリッシャー登録が残っている場合の保険
 * (ブリッジが登録解除せずに落ちると、登録は最大15分残る)
 */
const FORCE_RECONNECT_MS = 120000;

/**
 * 音声受信のバッファ目標(ミリ秒)。
 *
 * 配信者がマイクを入れ直しても購読を作り直さない方針にしたため、送信が
 * 途切れて再開したときのバッファの厚みがそのまま残り、遅延として出る
 * (受信側は途切れを検知すると安全側に倒してバッファを厚くする)。
 * 再開のたびに目標値を入れ直して詰める。小さくするほど遅延は減るが、
 * 回線が不安定なときに途切れやすくなるため、ポーズの目標遅延と同程度にしている
 */
const AUDIO_JITTER_TARGET_MS = 100;

interface SfuStatus {
  enabled: boolean;
  publisherReady: boolean;
  /** 配信元の識別子。古いサーバーは返さないため null/undefined を許容する */
  publisherSessionId?: string | null;
  audio: { sessionId: string; trackName: string } | null;
}

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
  /** サーバーから届いた最新の音声パブリッシャー(未接続時はここで保留する) */
  private pendingAudio: { sessionId: string; trackName: string } | null = null;
  private audioSubscribedSession: string | null = null;
  /**
   * 音声の購読処理を直列化する。押し出しの受信と接続完了が同時に走ると、
   * 同じトラックへ tracks/new を二重に投げ、再ネゴシエーションが衝突して
   * ontrack が発火しないことがある(音声ONボタンが出たり出なかったりする)
   */
  private audioQueue: Promise<void> = Promise.resolve();
  /** DataChannelが開通しているか。開通前に購読を始めると上記の衝突を招く */
  private channelOpen = false;
  /** 最後に通知した音声トラック。同じものを重複して通知しないために持つ */
  private lastAudioTrack: MediaStreamTrack | null = null;
  private mySessionId: string | null = null;
  /** いま購読している配信元。これが変わったときだけ張り直す必要がある */
  private subscribedPublisher: string | null = null;
  /** 無受信中の状態確認タイマー(セッションは作らない) */
  private idleTimer: number | null = null;
  /** 状態確認の現在の間隔。変化が無いあいだ伸びていく */
  private idlePollMs = IDLE_POLL_MS;
  /** タブが表示に戻ったときに即座に確認し直すためのハンドラ */
  private onVisible: (() => void) | null = null;
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
    this.stopIdlePoll();
    this.pc?.close();
    this.pc = null;
    this.channelOpen = false;
    // 新しいセッションではトラックの購読もやり直しになる
    this.audioSubscribedSession = null;
    this.lastAudioTrack = null;

    /**
     * セッションを作る前に配信元の有無を確認する。
     * 居ないのに作ると直後の subscribe が 503 になり、作ったセッションを
     * そのまま捨てることになる(1回あたりCloudflare APIへの発信を伴う)。
     * 状態APIはKV読みだけなので、この確認自体は安い
     */
    const precheck = await this.fetchStatus();
    if (generation !== this.generation) return;
    if (precheck && !precheck.publisherReady) {
      this.onStatus?.('配信の開始を待っています');
      this.startIdlePoll(generation);
      return;
    }

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
        if (event.track.kind === 'audio') this.reportAudioTrack(event.track);
      };

      const sub = await this.apiPost('/api/sfu/subscribe', { sessionId: session.sessionId });
      // どの配信元を購読したかを覚えておく。以後の無受信時に「配信元が変わったのか、
      // 単に送信が止まっているだけなのか」を区別するのに使う
      this.subscribedPublisher =
        typeof sub.publisherSessionId === 'string' ? sub.publisherSessionId : null;
      const channel = pc.createDataChannel(String(sub.name), {
        negotiated: true,
        id: Number(sub.id),
      });
      channel.binaryType = 'arraybuffer';

      channel.onopen = () => {
        if (generation !== this.generation) return;
        // ここでは retryCount を戻さない。チャンネルが開いてもデータが来ない状態が
        // あり、そこで戻すとバックオフが伸びず、短い周期でセッションを
        // 作り直し続けることになる(実際に無料枠を使い切る原因になっていた)
        this.lastPacketAt = performance.now();
        this.channelOpen = true;
        this.startWatchdog(generation);
        // 接続前にサーバーから届いていた音声の状態をここで適用する
        this.queueAudioApply();
        this.onStatus?.('SFU接続完了(DataChannel購読中)');
      };
      channel.onmessage = (event) => {
        this.lastPacketAt = performance.now();
        // 実際にデータが届いて初めて「接続成功」とみなす
        this.retryCount = 0;
        // 様子見の最中かどうかは onVisible の有無で見る
        // (idleTimer は非同期の確認中に一時的に null になる)
        if (this.onVisible !== null) {
          // 無受信の様子見から復帰した
          this.stopIdlePoll();
          this.startWatchdog(generation);
          this.onStatus?.('SFU接続完了(DataChannel購読中)');
        }
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
   * 音声パブリッシャーの変化を伝える。
   *
   * 以前はここを30秒間隔のポーリングで賄っていたが、視聴者1人あたり1日2,880回に
   * なるうえ反応も遅かった。いまはサーバーが presence WebSocket で押し出し、
   * 呼び出し側(視聴ページ)がそれをこのメソッドへ渡す。
   * 接続前に呼ばれた場合は状態だけ覚えておき、接続後に適用する。
   */
  setAudioPublisher(audio: { sessionId: string; trackName: string } | null): void {
    this.pendingAudio = audio;
    this.queueAudioApply();
  }

  /** 購読処理を直列に積む(同時に走らせない) */
  private queueAudioApply(): void {
    this.audioQueue = this.audioQueue.then(() => this.applyAudioPublisher()).catch(() => {});
  }

  private async applyAudioPublisher(): Promise<void> {
    const generation = this.generation;
    const audio = this.pendingAudio;

    if (!audio) {
      /**
       * 配信者が音声を止めた。
       *
       * **audioSubscribedSession は消さない。** これは「どの配信元をSFUで
       * 購読しているか」であって、配信者がマイクを切ってもSFU側の購読
       * (トランシーバ)は残っている。ここで消すと再開時に購読をやり直し、
       * トランシーバがON/OFFのたびに増えていく。
       *
       * 一方、通知の記録は必ず消す。条件を付けて囲うと、購読に失敗した回に
       * 記録が残り、以後の入れ直しが全て「同じトラック」と見なされて
       * 通知されなくなる
       */
      this.reportAudioTrack(null);
      return;
    }
    // DataChannel開通前に購読を始めると再ネゴシエーションが衝突する。
    // 開通後に channel.onopen から改めて適用されるので、ここでは待つだけでよい
    if (!this.channelOpen || !this.pc || !this.mySessionId) return;

    if (audio.sessionId === this.audioSubscribedSession) {
      /**
       * 同じ配信元を購読済み。配信者がマイクを入れ直しただけなので、
       * **購読をやり直さない。** やり直すとSFUがトランシーバを追加し、
       * ON/OFFのたびに視聴側へ積み上がっていく。
       * 停止時に通知を消しているので、いま来ているトラックを拾い直して
       * 「また鳴り始めた」ことだけ伝える(再生側は繋ぎ直さず音量を戻すだけ)
       */
      const live = this.liveAudioTrack();
      if (live) this.reportAudioTrack(live);
      return;
    }

    // ontrack が発火したかどうかを見るため、購読前の通知内容を控えておく
    const beforeTrack = this.lastAudioTrack;
    try {
      const result = await this.apiPost('/api/sfu/tracks/new', {
        sessionId: this.mySessionId,
        tracks: [{ location: 'remote', sessionId: audio.sessionId, trackName: audio.trackName }],
      });
      if (generation !== this.generation || !this.pc) return;
      const desc = result.sessionDescription as { type: string; sdp: string } | undefined;
      if (result.requiresImmediateRenegotiation && desc) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: desc.sdp });
        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);
        await this.apiPost('/api/sfu/renegotiate', { sessionId: this.mySessionId, sdp: answer.sdp });
      }
      this.audioSubscribedSession = audio.sessionId;

      /**
       * 再ネゴシエーションが起きた回は ontrack が正しいトラックを通知済みなので、
       * ここでは何もしない。**上書きすると壊れる。**
       *
       * 配信者がマイクを入れ直すと新しい配信セッションになるため、視聴側の
       * セッションには**古い(死んだ)トラックのトランシーバが残ったまま**
       * 新しいものが増える。そこで `getReceivers()` の先頭を拾うと、
       * 1本目=死んだトラックを掴んでしまい、無音になる。
       *
       * 再ネゴシエーションが起きなかった回(SFUがトランシーバを使い回した回)は
       * ontrack が発火しないので、そのときだけ受信側から拾う。
       * 拾うときも readyState を見て、生きているものの最新を選ぶ
       */
      if (this.lastAudioTrack === beforeTrack) {
        const received = this.liveAudioTrack();
        if (received) this.reportAudioTrack(received);
      }
    } catch (error) {
      console.warn('[sfu] 音声トラックの購読に失敗:', error);
    }
  }

  /**
   * 音声受信のバッファ目標を明示して、再開時に残った遅延を詰める。
   * 対応していない環境では何も起こらない(既定の適応制御のまま)
   */
  private tuneAudioLatency(): void {
    if (!this.pc) return;
    for (const receiver of this.pc.getReceivers()) {
      if (receiver.track?.kind !== 'audio') continue;
      // 型定義に無い/環境によって有無が変わるプロパティなので緩く扱う
      const tunable = receiver as unknown as Record<string, unknown>;
      try {
        if ('jitterBufferTarget' in tunable) {
          tunable.jitterBufferTarget = AUDIO_JITTER_TARGET_MS; // 標準API(ミリ秒)
        } else if ('playoutDelayHint' in tunable) {
          tunable.playoutDelayHint = AUDIO_JITTER_TARGET_MS / 1000; // 旧Chrome(秒)
        }
      } catch {
        // 設定できない環境では既定のまま
      }
    }
  }

  /**
   * いま受け取れている音声トラック。
   * 配信元が入れ替わると古い(終了した)トラックが残るため、生きているものの
   * 最新を選ぶ。先頭を拾うと死んだトラックを掴んで無音になる
   */
  private liveAudioTrack(): MediaStreamTrack | null {
    return (
      this.pc
        ?.getReceivers()
        .map((r) => r.track)
        .filter((t): t is MediaStreamTrack => t?.kind === 'audio' && t.readyState === 'live')
        .at(-1) ?? null
    );
  }

  /**
   * 音声トラックの通知。ontrack と購読完了の両方から呼ばれるため、
   * 同じトラックを二度通知しない(再生側でノードを繋ぎ直す無駄を避ける)
   */
  private reportAudioTrack(track: MediaStreamTrack | null): void {
    if (track === this.lastAudioTrack) return;
    this.lastAudioTrack = track;
    if (track) this.tuneAudioLatency();
    // 再生側で例外が出ても購読処理は続ける。両者は独立した関心事で、
    // 実際に再生側の例外が ontrack と購読処理の両方を巻き込んで止めていた
    try {
      this.onAudioTrack?.(track);
    } catch (error) {
      console.warn('[sfu] 音声トラックの受け渡しで例外:', error);
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
        // ここで張り直さないのが要点。まず状態を見に行く様子見モードへ移る
        this.stopWatchdog();
        this.onStatus?.(`${STALE_TIMEOUT_MS / 1000}秒間モーションが届いていません。確認しています`);
        this.startIdlePoll(generation);
      }
    }, 2000);
  }

  private stopWatchdog(): void {
    if (this.watchdogTimer !== null) {
      window.clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  /** 状態API(KV読みのみ)。取得できなければ null */
  private async fetchStatus(): Promise<SfuStatus | null> {
    try {
      const res = await fetch(`${this.baseUrl}${withAuth('/api/sfu/status', this.room, this.auth)}`, {
        headers: await this.auth.headers(),
      });
      if (!res.ok) return null;
      return (await res.json()) as SfuStatus;
    } catch {
      return null;
    }
  }

  /**
   * 無受信中の様子見。**セッションは作らない。**
   * 状態APIだけを見て、本当に張り直しが必要なときにのみ open() する
   */
  private startIdlePoll(generation: number): void {
    this.stopIdlePoll();
    this.idlePollMs = IDLE_POLL_MS;

    const schedule = (): void => {
      if (generation !== this.generation) return;
      this.idleTimer = window.setTimeout(() => void poll(), this.idlePollMs);
      // 変化が無いあいだは間隔を伸ばす。開きっぱなしのタブの積み上がりを抑える
      this.idlePollMs = Math.min(IDLE_POLL_MAX_MS, this.idlePollMs * 2);
    };

    const poll = async (): Promise<void> => {
      this.idleTimer = null;
      if (generation !== this.generation) return;
      const status = await this.fetchStatus();
      if (generation !== this.generation) return;
      if (!status) {
        schedule(); // 一時的な失敗。次の間隔で見直す
        return;
      }

      if (!status.publisherReady) {
        // 配信していないだけ。ここでセッションを作り直していたのが浪費の原因だった
        if (this.pc) {
          this.pc.close();
          this.pc = null;
          this.channelOpen = false;
          this.reportAudioTrack(null);
          this.audioSubscribedSession = null;
          this.subscribedPublisher = null;
        }
        this.onStatus?.('配信の開始を待っています');
        schedule();
        return;
      }

      // 配信元が変わった場合だけ張り直す。古いサーバーはIDを返さないので、
      // その場合は「変わっていない」とみなし、下の時間切れの判定に任せる
      const changed =
        typeof status.publisherSessionId === 'string' &&
        status.publisherSessionId !== this.subscribedPublisher;
      /**
       * 保険の張り直し。ただし音声を購読できているならセッションは生きている
       * 証拠なので張り直さない。**張り直すと音声が途切れる**ため、
       * 「モーションだけ止まっている配信」で2分ごとに音が切れることになる
       */
      const stalledTooLong =
        this.audioSubscribedSession === null &&
        performance.now() - this.lastPacketAt > FORCE_RECONNECT_MS;

      if (!this.pc || changed || stalledTooLong) {
        this.stopIdlePoll();
        this.retryCount = 0; // 状態変化に基づく張り直しなので待たずに繋ぐ
        this.onStatus?.(changed ? '配信元が変わりました。接続し直します' : '接続を張り直します');
        void this.open();
        return;
      }

      // 配信元は同じで接続も生きている = 送信が止まっているだけ。何もしない
      this.onStatus?.('配信元は接続中です(モーションの再開待ち)');
      schedule();
    };

    /**
     * タブが表示に戻ったら即座に確認し、間隔も最短へ戻す。
     * 間隔を伸ばしたままだと「戻ってきたのに配信が始まらない」ように見えるため
     */
    this.onVisible = (): void => {
      if (generation !== this.generation) return;
      if (document.visibilityState !== 'visible') return;
      this.idlePollMs = IDLE_POLL_MS;
      if (this.idleTimer !== null) {
        window.clearTimeout(this.idleTimer);
        this.idleTimer = null;
        void poll();
      }
    };
    document.addEventListener('visibilitychange', this.onVisible);

    void poll();
  }

  private stopIdlePoll(): void {
    if (this.idleTimer !== null) {
      window.clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.onVisible) {
      document.removeEventListener('visibilitychange', this.onVisible);
      this.onVisible = null;
    }
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUser) return;
    this.stopWatchdog();
    this.stopIdlePoll();
    this.pc?.close();
    this.pc = null;
    this.channelOpen = false;
    // 張り直すと同じトラックを購読し直す必要がある
    this.audioSubscribedSession = null;
    this.lastAudioTrack = null;
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
    this.stopIdlePoll();
    this.channelOpen = false;
    this.audioSubscribedSession = null;
    this.lastAudioTrack = null;
    if (this.retryTimer !== null) {
      window.clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    this.pc?.close();
    this.pc = null;
    this.onStatus?.('SFU切断');
  }
}
