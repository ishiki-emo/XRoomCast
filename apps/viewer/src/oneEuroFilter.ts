/**
 * One Euro フィルター(Casiez ら, 2012)。推定値の細かい震えを抑えつつ、速い動きには遅れずに追いつく。
 *
 * 一定の割合で前回値へ寄せるだけ(指数移動平均)だと、止まっているときの震えを消すほど強くすると
 * 動いたときに大きく遅れる。One Euro は、値の変化の速さに応じてならし具合を変える:
 * ゆっくりなら強くならし(震えが消える)、速ければ弱める(遅れない)。
 * Webカメラの推定(MediaPipe)の揺れ取りでよく使われる
 */

function smoothingFactor(elapsedSec: number, cutoffHz: number): number {
  const r = 2 * Math.PI * cutoffHz * elapsedSec;
  return r / (r + 1);
}

export class OneEuroFilter {
  private value: number[] | null = null;
  private derivative: number[] = [];
  private lastTime = 0;

  /**
   * @param minCutoff 止まっているときのならし具合(Hz)。小さいほど震えが消えるが、ゆっくりした動きが遅れる
   * @param beta 速さに応じてならしを弱める度合い。大きいほど速い動きに遅れない
   * @param derivativeCutoff 速さそのもののならし具合(Hz)
   */
  constructor(
    private minCutoff: number,
    private beta: number,
    private readonly derivativeCutoff = 1,
  ) {}

  /** ならし具合を変える(滑らかさの設定を動かしたとき)。値は保ったまま次から効く */
  setParams(minCutoff: number, beta: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
  }

  /** 新しい値を入れて、ならした値を返す(out に書く)。time は秒 */
  filter(input: readonly number[], time: number, out: number[]): number[] {
    if (!this.value || this.value.length !== input.length || time <= this.lastTime) {
      if (!this.value || this.value.length !== input.length) {
        this.value = [...input];
        this.derivative = input.map(() => 0);
        this.lastTime = time;
      }
      out.length = input.length;
      for (let i = 0; i < input.length; i++) out[i] = this.value[i]!;
      return out;
    }
    const elapsed = time - this.lastTime;
    this.lastTime = time;
    const alphaD = smoothingFactor(elapsed, this.derivativeCutoff);
    out.length = input.length;
    for (let i = 0; i < input.length; i++) {
      const previous = this.value[i]!;
      const rate = (input[i]! - previous) / elapsed;
      const d = this.derivative[i]! + alphaD * (rate - this.derivative[i]!);
      this.derivative[i] = d;
      const alpha = smoothingFactor(elapsed, this.minCutoff + this.beta * Math.abs(d));
      out[i] = this.value[i] = previous + alpha * (input[i]! - previous);
    }
    return out;
  }

  /** 次の値から始め直す(見失ったあとに、離れた位置へ引きずられないように) */
  reset(): void {
    this.value = null;
  }
}
