/**
 * 配信者コンソールの鏡・プレビュー用のリップシンク。
 *
 * 視聴側(spatialAudio.sampleLipSync)は受信した音声を解析するが、配信者は自分の声を
 * 受信しないため、取得したマイクの音を同じ VowelEstimator にかけて口を動かす。
 * 端末の中だけで完結し、何も送らない。視聴者に届くのはSFU経由のぶん少し遅れる。
 *
 * 再生はしない(destinationには繋がない。自分の声が返ってくるのを防ぐ)
 */
import { VowelEstimator, type LipSyncWeights } from '@xroomcast/viewer-core';

export class MicLipSync {
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private analyser: AnalyserNode | null = null;
  private freqBuffer: Float32Array<ArrayBuffer> | null = null;
  private estimator: VowelEstimator | null = null;

  /** マイクの取得・解放に合わせて呼ぶ。null で解析を止める */
  setTrack(track: MediaStreamTrack | null): void {
    this.source?.disconnect();
    this.source = null;
    if (!track) return;
    try {
      if (!this.context) {
        this.context = new AudioContext();
        const analyser = this.context.createAnalyser();
        // 視聴側(spatialAudio)と同じ設定にして、口の動きを揃える
        analyser.fftSize = 2048;
        analyser.smoothingTimeConstant = 0.6;
        this.analyser = analyser;
        this.freqBuffer = new Float32Array(analyser.frequencyBinCount);
        this.estimator = new VowelEstimator(this.context.sampleRate, analyser.frequencyBinCount);
      }
      // マイク開始はボタン操作の中なので、ここで再開できる
      void this.context.resume();
      this.source = this.context.createMediaStreamSource(new MediaStream([track]));
      this.source.connect(this.analyser!);
    } catch (error) {
      // 口が動かないだけで配信には影響しない
      console.warn('[micLipSync] マイクの解析を開始できませんでした:', error);
      this.source = null;
    }
  }

  /** マイクが無いときは null(口は閉じる) */
  sample(delta: number): LipSyncWeights | null {
    if (!this.source || !this.analyser || !this.freqBuffer || !this.estimator) return null;
    this.analyser.getFloatFrequencyData(this.freqBuffer);
    return this.estimator.estimate(this.freqBuffer, delta);
  }
}
