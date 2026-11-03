/**
 * AR中の照明推定(WebXR Lighting Estimation)。部屋の明るさと光の向きをアバターへ反映する。
 *
 * three.js の XREstimatedLight と同じ値の使い方をしているが、自前で持つ理由:
 * - あちらはどのXRセッションでも requestLightProbe を呼び、許可されていないと
 *   catch されない reject が出る。ここでは許可された時だけ要求する
 * - 環境マップ(反射キューブマップ)は使わない。MToon はほぼ参照せず、
 *   スマホでは毎フレームのGPU負荷になるだけなので
 * - 推定値は暗い部屋で極端に落ちるため、既定のライトを下限として残す
 *
 * 対応は Chrome(Android / Android XR)。Quest・PICO では許可されず、何もしない
 */
import * as THREE from 'three';

// 照明推定は @types/webxr に無いので、使う分だけ定義する(WebXR Lighting Estimation API)
type LightProbeHandle = EventTarget;
interface LightEstimate {
  readonly sphericalHarmonicsCoefficients: Float32Array;
  readonly primaryLightDirection: DOMPointReadOnly;
  readonly primaryLightIntensity: DOMPointReadOnly;
}
type LightSession = XRSession & { requestLightProbe?: () => Promise<LightProbeHandle> };
type LightFrame = XRFrame & {
  getLightEstimate?: (probe: LightProbeHandle) => LightEstimate | null;
};

/**
 * 推定が効いている間、既定のライト(scenery)へ掛ける倍率。
 * 0にすると暗い部屋でアバターが真っ黒に沈むので、少し残して下限にする
 */
export const DEFAULT_LIGHT_SCALE_WHILE_ESTIMATING = 0.35;
/** 推定の主光源の強さの上限。窓際の直射などで白飛びしないように */
const MAX_DIRECTIONAL_INTENSITY = 3;
/** 毎フレーム推定値へ寄せる割合。推定は細かく揺れるので、ゆっくり追わせる */
const FOLLOW = 0.1;

export class ArLighting {
  private readonly probeLight = new THREE.LightProbe();
  private readonly directional = new THREE.DirectionalLight(0xffffff, 0);
  private readonly targetSh = new THREE.SphericalHarmonics3();
  private readonly targetColor = new THREE.Color();
  private readonly targetDirection = new THREE.Vector3();
  private targetIntensity = 0;

  private probe: LightProbeHandle | null = null;
  private estimating = false;
  /** stop() 後に遅れて requestLightProbe が解決したときに捨てるため */
  private generation = 0;

  constructor(
    scene: THREE.Scene,
    /** 既定のライトへ掛ける倍率が変わったとき(推定の開始・終了) */
    private readonly onDefaultLightScale: (scale: number) => void,
  ) {
    this.probeLight.intensity = 0;
    scene.add(this.probeLight, this.directional);
  }

  start(session: LightSession): void {
    const enabled = (session as unknown as { enabledFeatures?: readonly string[] })
      .enabledFeatures;
    if (!enabled?.includes('light-estimation') || !session.requestLightProbe) return;
    const generation = ++this.generation;
    session
      .requestLightProbe()
      .then((probe) => {
        if (generation === this.generation) this.probe = probe;
      })
      .catch((error: unknown) => console.warn('[ar] 照明推定を開始できません:', error));
  }

  update(frame: LightFrame): void {
    if (!this.probe) return;
    const estimate = frame.getLightEstimate?.(this.probe);
    if (!estimate) return;

    this.targetSh.fromArray(Array.from(estimate.sphericalHarmonicsCoefficients));
    // WebXRの色は1を超えて返るので、最大成分で割って色と強さに分ける
    const i = estimate.primaryLightIntensity;
    const scalar = Math.max(1, i.x, i.y, i.z);
    this.targetColor.setRGB(i.x / scalar, i.y / scalar, i.z / scalar);
    this.targetIntensity = Math.min(scalar, MAX_DIRECTIONAL_INTENSITY);
    const d = estimate.primaryLightDirection;
    this.targetDirection.set(d.x, d.y, d.z);

    if (!this.estimating) {
      // 初回は寄せずにそのまま使う(既定のライトを絞るのと同時に切り替える)
      this.estimating = true;
      this.probeLight.sh.copy(this.targetSh);
      this.probeLight.intensity = 1;
      this.directional.color.copy(this.targetColor);
      this.directional.intensity = this.targetIntensity;
      this.directional.position.copy(this.targetDirection);
      this.onDefaultLightScale(DEFAULT_LIGHT_SCALE_WHILE_ESTIMATING);
      console.log('[ar] 照明推定を開始しました');
      return;
    }
    this.probeLight.sh.lerp(this.targetSh, FOLLOW);
    this.directional.color.lerp(this.targetColor, FOLLOW);
    this.directional.intensity += (this.targetIntensity - this.directional.intensity) * FOLLOW;
    // 光の向き(光源への方向)。target は原点なので position がそのまま向きになる
    this.directional.position.lerp(this.targetDirection, FOLLOW);
  }

  stop(): void {
    this.generation++;
    this.probe = null;
    this.probeLight.intensity = 0;
    this.directional.intensity = 0;
    if (this.estimating) {
      this.estimating = false;
      this.onDefaultLightScale(1);
    }
  }
}
