/**
 * 音声解析ベースのリアルタイムリップシンク(母音推定)。
 *
 * 受信音声の周波数スペクトルから帯域エネルギーの比で母音を推定し、
 * VRMの表情(aa/ih/ou/ee/oh)の重みを返す。口形データを送らないため
 * 追加帯域はゼロで、遅延も再生音声と自然に揃う(同じ音を見ているため)。
 *
 * 厳密なフォルマント解析はしない。配信の口パクに必要なのは
 * 「声量で口が開き、音色で形が変わって見える」ことなので、
 * 低/中/高の3帯域と声量だけで駆動する(0.1ms/frame程度)。
 */

export interface LipSyncWeights {
  aa: number;
  ih: number;
  ou: number;
  ee: number;
  oh: number;
}

/** 無音〜小声を口パクさせないゲート(AGC後の相対値) */
const GATE = 0.06;
/** 開く速さと閉じる速さ(秒)。閉じる方を遅くすると口の動きが自然に見える */
const ATTACK_TAU = 0.04;
const RELEASE_TAU = 0.12;
/** AGC(声量の自動調整)のピーク減衰時間(秒)。マイク距離や声の大小に追従する */
const AGC_DECAY_TAU = 3;
/**
 * これ以下の絶対音量は環境ノイズとみなす基準。
 * AGCは相対正規化なので、これが無いと**無音時の微小ノイズを増幅して
 * 口が全開のままになる**(ピークの下限として効かせる)
 */
const NOISE_FLOOR = 3e-6;

export class VowelEstimator {
  private readonly current: LipSyncWeights = { aa: 0, ih: 0, ou: 0, ee: 0, oh: 0 };
  /** AGC用のゆっくり減衰する声量ピーク */
  private peak = 1e-8;

  constructor(
    private readonly sampleRate: number,
    private readonly binCount: number,
  ) {}

  /**
   * 周波数データ(dB、AnalyserNode.getFloatFrequencyDataの出力)から
   * 母音の重みを推定する。無音時(-Infinity)は自然にゼロへ落ちる
   */
  estimate(freqDb: Float32Array, delta: number): LipSyncWeights {
    const hzPerBin = this.sampleRate / 2 / this.binCount;
    const band = (lowHz: number, highHz: number): number => {
      const from = Math.max(0, Math.floor(lowHz / hzPerBin));
      const to = Math.min(this.binCount - 1, Math.ceil(highHz / hzPerBin));
      let sum = 0;
      for (let i = from; i <= to; i += 1) sum += 10 ** (freqDb[i]! / 10); // dB→パワー
      return sum / Math.max(1, to - from + 1);
    };

    // 声の帯域を3分割。低域が強い=口の奥が鳴る音(お/う)、高域が強い=い/え
    const low = band(100, 600);
    const mid = band(600, 1500);
    const high = band(1500, 3500);
    const total = low + mid + high;

    // AGC: 直近のピークを基準に声量を0..1へ正規化する。
    // ピークはノイズフロアより下げない(微小ノイズを声として拾わない)
    this.peak = Math.max(
      total,
      this.peak * Math.exp(-delta / AGC_DECAY_TAU),
      NOISE_FLOOR * 15,
    );
    const loud = this.peak > 0 ? total / this.peak : 0;
    const openness = loud < GATE ? 0 : Math.min(1, (loud - GATE) / 0.5);

    // 高域寄りか低域寄りか(-1..1)。母音の形の手がかりにする
    const tilt = total > 0 ? (high - low) / total : 0;
    const toHigh = Math.max(0, Math.min(1, tilt * 1.6));
    const toLow = Math.max(0, Math.min(1, -tilt * 1.6));

    const target: LipSyncWeights = {
      aa: openness * (1 - 0.6 * Math.max(toHigh, toLow)),
      ih: openness * toHigh * 0.7,
      ee: openness * toHigh * 0.3,
      ou: openness * toLow * 0.7,
      oh: openness * toLow * 0.3,
    };

    // 生値の直挿しはノイズになるため、開きは速く・閉じはゆっくり追従させる
    for (const key of Object.keys(this.current) as (keyof LipSyncWeights)[]) {
      const tau = target[key] > this.current[key] ? ATTACK_TAU : RELEASE_TAU;
      this.current[key] += (target[key] - this.current[key]) * (1 - Math.exp(-delta / tau));
      if (this.current[key] < 0.001) this.current[key] = 0;
    }
    return this.current;
  }
}
