/**
 * 配信者の音声を「アバターの頭から鳴っている」ように再生する空間オーディオ。
 *
 * - AudioListener はカメラに付ける。three.jsがXRカメラの姿勢を元のカメラへ
 *   反映するので、HMDで頭を回すと音の方向もついてくる
 * - 音源(PositionalAudio)はシーン直下に置き、毎フレーム頭のワールド位置へ動かす。
 *   頭ボーンにぶら下げないので、アバターを差し替えても付け直しが要らない
 * - 空間OFF時は素の <audio> 側で鳴らす(スピーカー環境ではそのほうが聞き取りやすい)
 *
 * Chromeの既知の問題への対処: WebRTCのリモートストリームは、同じstreamを
 * <audio>要素にも設定しておかないとWeb Audioへ流れない。そのため空間ON時も
 * ミュートした <audio> にstreamを繋いだままにしている。
 */
import * as THREE from 'three';

/** 等身大(スケール1)での基準距離。これより近づいても音量は上がらない */
const BASE_REF_DISTANCE = 1.2;
/** 距離減衰の強さ。1より小さいと遠くでも聞こえやすい */
const ROLLOFF_FACTOR = 0.6;
const MAX_DISTANCE = 40;

export class SpatialAudio {
  readonly listener: THREE.AudioListener;
  private readonly positional: THREE.PositionalAudio;
  /** Chrome対策 兼 空間OFF時の再生先 */
  private readonly sink = new Audio();
  private spatial = true;
  private muted = true;
  private hasTrack = false;
  /** いまWebAudioへ繋いでいるトラック。同じものを繋ぎ直さないために持つ */
  private currentTrack: MediaStreamTrack | null = null;

  constructor(camera: THREE.Camera, scene: THREE.Scene) {
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);

    this.positional = new THREE.PositionalAudio(this.listener);
    this.positional.setDistanceModel('inverse');
    this.positional.setRefDistance(BASE_REF_DISTANCE);
    this.positional.setRolloffFactor(ROLLOFF_FACTOR);
    this.positional.setMaxDistance(MAX_DISTANCE);
    this.positional.setVolume(0);
    scene.add(this.positional);

    this.sink.autoplay = true;
    this.sink.muted = true;
  }

  get isSpatial(): boolean {
    return this.spatial;
  }

  /**
   * 前のソースを切り離す(繋ぎっぱなしにするとノードが積み上がる)。
   *
   * `positional.source` は一度設定されると切断しても残るため、
   * 「解除 → 再設定」と続けて呼ぶと**既に切れているノードをもう一度切ろうとして**
   * WebAudioが InvalidAccessError を投げる。切れていること自体が目的なので握り潰す。
   * これを放置すると setTrack の呼び出し元まで例外が伝播し、
   * 音声ONボタンの表示や購読処理そのものが巻き添えで止まる
   */
  private detachSource(): void {
    if (!this.positional.source) return;
    try {
      this.positional.disconnect();
    } catch {
      // 既に切断済み。何もしなくてよい
    }
  }

  /**
   * 音声トラックの差し替え(nullで解除)。
   *
   * **同じトラックに対してノードを作り直してはいけない。** WebRTCのリモート
   * トラックから MediaStreamAudioSourceNode を作り直すと、Chromeでは以降
   * 無音になる(1つのトラックを複数のソースノードで受けられない)。
   * 配信者がマイクを入れ直すとSFUはトランシーバを使い回すため、
   * ここには**前回と同一のトラックオブジェクト**が渡ってくる。
   *
   * そのため解除時もノードは残したままにし、音の開始/停止は
   * ルーティング(音量とミュート)だけで行う。ノードを作り直すのは
   * 本当に別のトラックへ変わったときだけ。
   */
  setTrack(track: MediaStreamTrack | null): void {
    if (track !== null && track === this.currentTrack) {
      // 同じ配信が戻ってきた。繋ぎ直さずに鳴らし直すだけでよい
      this.hasTrack = true;
      this.applyRouting();
      return;
    }

    if (!track) {
      // ノードとstreamは繋いだまま残す(同じトラックの復帰に備える)
      this.hasTrack = false;
      this.applyRouting();
      return;
    }

    // 別のトラックに変わった(再接続などでPeerConnectionごと入れ替わった場合)
    this.detachSource();
    this.currentTrack = track;
    const stream = new MediaStream([track]);
    this.sink.srcObject = stream;
    void this.sink.play().catch(() => {});
    this.positional.setMediaStreamSource(stream);
    this.hasTrack = true;
    this.applyRouting();
  }

  /** ブラウザの自動再生制限のため、ユーザー操作の中から呼ぶ */
  async resume(): Promise<void> {
    const context = this.listener.context;
    if (context.state === 'suspended') await context.resume();
    void this.sink.play().catch(() => {});
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyRouting();
  }

  setSpatial(on: boolean): void {
    this.spatial = on;
    this.applyRouting();
  }

  /** 音源をアバターの頭へ動かす(毎フレーム) */
  setSourcePosition(position: THREE.Vector3): void {
    this.positional.position.copy(position);
  }

  /**
   * アバターの表示スケールに追従させる。
   * 卓上ミニサイズではアバターが近くにあるので、基準距離も同じ比率で縮める
   * (そうしないと近すぎて音量が張り付く)
   */
  setAvatarScale(scale: number): void {
    this.positional.setRefDistance(BASE_REF_DISTANCE * Math.max(scale, 0.02));
  }

  private applyRouting(): void {
    const audible = this.hasTrack && !this.muted;
    this.positional.setVolume(audible && this.spatial ? 1 : 0);
    // 空間ONのときは <audio> を鳴らさない(二重再生を防ぐ)。
    // ただしstreamは繋いだままにする(Chromeでは外すとWeb Audioにも流れなくなる)
    this.sink.muted = !audible || this.spatial;
  }
}
