/**
 * 配信者の音声を「アバターの頭から鳴っている」ように再生する空間オーディオ。
 *
 * - AudioListener はカメラに付ける。three.jsがXRカメラの姿勢を元のカメラへ
 *   反映するので、HMDで頭を回すと音の方向もついてくる
 * - 音源(PositionalAudio)はシーン直下に置き、毎フレーム頭のワールド位置へ動かす。
 *   頭ボーンにぶら下げないので、アバターを差し替えても付け直しが要らない
 * - 空間OFF時は素の <audio> 側で鳴らす(スピーカー環境ではそのほうが聞き取りやすい)
 * - 複数配信者では席(slot)ごとに音源を1つ持つ。(positional + sink + track) の
 *   3点セットは席単位で独立させる(Chrome/iOSの制約が席ごとに絡むため)
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

/**
 * 空間オーディオが使えるか。
 *
 * **iOS(WebKit)はWebRTCのリモート音声をWeb Audioへ流せない**という制約がある。
 * 空間ONだと `<audio>` をミュートしてWeb Audio側で鳴らす作りなので、
 * iOSでは**完全に無音になる**。しかも `<audio>.volume` はiOSでは変更できないため、
 * 「鳴らしつつ音量を絞る」という逃げ道も無い。
 *
 * iOSのブラウザは中身がすべてWebKitなので、プラットフォームで判定してよい
 * (iPadOSはUAがMacを名乗るため、タッチ点数と併せて見る)
 */
export function isSpatialAudioSupported(): boolean {
  if (typeof navigator === 'undefined') return true;
  const ua = navigator.userAgent;
  const iOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(ua));
  return !iOS;
}

/**
 * 席1つぶんの音源。positional(空間再生)・sink(Chrome対策 兼 通常再生)・
 * currentTrack(繋ぎ直し防止)を1セットで持つ
 */
class SpatialSource {
  readonly positional: THREE.PositionalAudio;
  readonly sink = new Audio();
  hasTrack = false;
  /** いまWebAudioへ繋いでいるトラック。同じものを繋ぎ直さないために持つ */
  currentTrack: MediaStreamTrack | null = null;

  constructor(listener: THREE.AudioListener, scene: THREE.Scene, refDistance: number) {
    this.positional = new THREE.PositionalAudio(listener);
    this.positional.setDistanceModel('inverse');
    this.positional.setRefDistance(refDistance);
    this.positional.setRolloffFactor(ROLLOFF_FACTOR);
    this.positional.setMaxDistance(MAX_DISTANCE);
    this.positional.setVolume(0);
    scene.add(this.positional);

    this.sink.autoplay = true;
    this.sink.muted = true;
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
  detachSource(): void {
    if (!this.positional.source) return;
    try {
      this.positional.disconnect();
    } catch {
      // 既に切断済み。何もしなくてよい
    }
  }

  dispose(scene: THREE.Scene): void {
    this.detachSource();
    scene.remove(this.positional);
    this.sink.srcObject = null;
    this.currentTrack = null;
    this.hasTrack = false;
  }
}

export class SpatialAudio {
  readonly listener: THREE.AudioListener;
  /**
   * この端末で空間オーディオが使えるか。使えない端末では、設定に関わらず
   * 通常再生へ回す(黙って無音になるより、鳴るほうがましなので)
   */
  readonly spatialSupported = isSpatialAudioSupported();
  private spatial = true;
  private muted = true;
  private avatarScale = 1;
  private readonly scene: THREE.Scene;
  /** 席番号 → 音源 */
  private readonly sources = new Map<number, SpatialSource>();

  constructor(camera: THREE.Camera, scene: THREE.Scene) {
    this.scene = scene;
    this.listener = new THREE.AudioListener();
    camera.add(this.listener);
  }

  get isSpatial(): boolean {
    return this.spatial;
  }

  private getSource(slot: number): SpatialSource {
    let source = this.sources.get(slot);
    if (!source) {
      source = new SpatialSource(
        this.listener,
        this.scene,
        BASE_REF_DISTANCE * Math.max(this.avatarScale, 0.02),
      );
      this.sources.set(slot, source);
    }
    return source;
  }

  /**
   * 音声トラックの差し替え(nullで解除)。席ごとに独立して管理する。
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
  setTrack(track: MediaStreamTrack | null, slot = 0): void {
    const source = this.getSource(slot);
    if (track !== null && track === source.currentTrack) {
      // 同じ配信が戻ってきた。繋ぎ直さずに鳴らし直すだけでよい
      source.hasTrack = true;
      this.applyRouting(source);
      return;
    }

    if (!track) {
      // ノードとstreamは繋いだまま残す(同じトラックの復帰に備える)
      source.hasTrack = false;
      this.applyRouting(source);
      return;
    }

    // 別のトラックに変わった(再接続などでPeerConnectionごと入れ替わった場合)
    source.detachSource();
    source.currentTrack = track;
    const stream = new MediaStream([track]);
    source.sink.srcObject = stream;
    void source.sink.play().catch(() => {});
    source.positional.setMediaStreamSource(stream);
    source.hasTrack = true;
    this.applyRouting(source);
  }

  /** 席の音源ごと片付ける(配信者の退場時) */
  removeSource(slot: number): void {
    const source = this.sources.get(slot);
    if (!source) return;
    source.dispose(this.scene);
    this.sources.delete(slot);
  }

  /** ブラウザの自動再生制限のため、ユーザー操作の中から呼ぶ */
  async resume(): Promise<void> {
    const context = this.listener.context;
    if (context.state === 'suspended') await context.resume();
    for (const source of this.sources.values()) {
      void source.sink.play().catch(() => {});
    }
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.applyRoutingAll();
  }

  setSpatial(on: boolean): void {
    this.spatial = on;
    this.applyRoutingAll();
  }

  /** 音源をアバターの頭へ動かす(毎フレーム・席ごと) */
  setSourcePosition(position: THREE.Vector3, slot = 0): void {
    this.sources.get(slot)?.positional.position.copy(position);
  }

  /**
   * アバターの表示スケールに追従させる。
   * 卓上ミニサイズではアバターが近くにあるので、基準距離も同じ比率で縮める
   * (そうしないと近すぎて音量が張り付く)
   */
  setAvatarScale(scale: number): void {
    this.avatarScale = scale;
    const refDistance = BASE_REF_DISTANCE * Math.max(scale, 0.02);
    for (const source of this.sources.values()) {
      source.positional.setRefDistance(refDistance);
    }
  }

  private applyRoutingAll(): void {
    for (const source of this.sources.values()) this.applyRouting(source);
  }

  private applyRouting(source: SpatialSource): void {
    const audible = source.hasTrack && !this.muted;
    // 使えない端末では空間ONでも通常再生へ回す(黙って無音にしない)
    const spatial = this.spatial && this.spatialSupported;
    source.positional.setVolume(audible && spatial ? 1 : 0);
    // 空間ONのときは <audio> を鳴らさない(二重再生を防ぐ)。
    // ただしstreamは繋いだままにする(Chromeでは外すとWeb Audioにも流れなくなる)
    source.sink.muted = !audible || spatial;
  }
}
