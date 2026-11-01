/**
 * 深度オクルージョン(WebXR Depth Sensing)。現実の人や家具がアバターより手前にあれば、アバターを隠す。
 *
 * 毎フレーム端末の深度テクスチャを受け取り、色を描かず深度だけ書く全画面メッシュをアバターより先に描く。
 *
 * - **three.js の深度処理は使わない**。three.js 0.172 は 'depth-sensing' が許可されると毎フレーム
 *   `glBinding.getDepthInformation()` を呼ぶが、glBinding は 'layers' を使うときにしか作らない。
 *   XRoomCast は layers を使わないので、そこで毎フレーム例外になり、描画ループごと止まる
 *   (Quest で UI も含めて何も出なくなった。0.187 では直っている)。
 *   なので three.js からは depth-sensing が許可されていないように見せ、深度の取得と描画をここで持つ
 * - **要求するかの判断**。深度は「テクスチャ配列・深度バッファ形式」で来る前提で、これは Quest の形。
 *   Android Chrome(ARCore)は2Dテクスチャ・ミリ単位で来るので噛み合わず、しかも許可された瞬間に
 *   フリーズする事例があった(ar.ts の注意書き)。既定では Quest でだけ要求する
 * - **奥行きの下駄**。センサーの深度は数cm揺れるうえ、床とアバターの足は同じ深さにある。
 *   そのままだと足元や体の表面がちらつくので、現実の深度を少し奥へずらしてから書く。
 *   誤差が「隠しすぎ」でなく「隠し足りない」側に倒れる(空中でアバターが欠けるほうが目立つ)
 * - 実機での確認用に、受け取った深度の形を診断の行として返す
 */
import * as THREE from 'three';

/** 現実の深度を奥へずらす量(メートル)。Quest の深度の揺れと、足の接地ぶん */
const DEPTH_BIAS_METERS = 0.05;

/**
 * 深度を要求するか。`?depth=1` / `?depth=0` で上書きできる(検証用)。
 * Android で `?depth=1` にするとフリーズの再現確認になるので、普段は使わない
 */
export function shouldRequestDepth(): boolean {
  const param = new URLSearchParams(location.search).get('depth');
  if (param === '1') return true;
  if (param === '0') return false;
  return /OculusBrowser/.test(navigator.userAgent);
}

/** requestSession に足す設定。GPUのテクスチャで受け取る(全画面メッシュで深度を書くため) */
export const DEPTH_SENSING_INIT = {
  usagePreference: ['gpu-optimized'],
  // 空にすると形式はブラウザに任せる
  dataFormatPreference: [],
  // 新しい仕様の「なめらかな深度」。対応していない端末では無視される
  depthTypeRequest: ['smooth'],
} as const;

// @types/webxr の型は depthNear/depthFar を持たないので、読む分だけの形で受ける
interface DepthInfoLike {
  width: number;
  height: number;
  texture?: WebGLTexture | null;
  /** 'texture' か 'texture-array' */
  textureType?: string;
  imageIndex?: number;
  rawValueToMeters?: number;
  depthNear?: number;
  depthFar?: number;
  isValid?: boolean;
}
interface DepthBinding {
  getDepthInformation?: (view: XRView) => DepthInfoLike | null;
}

/**
 * 深度テクスチャの値(深度バッファと同じ非線形の [0, 1])を、一度メートルへ戻して
 * 下駄を足し、描画の投影の深度へ書き直す。深度データの near/far と描画の near/far は
 * 別物なので分けて受ける。far が0以下なら無限遠の投影として扱う。
 *
 * 深度テクスチャは画面よりずっと粗いので、一番近い画素をそのまま使うと、隠れた部分の境界が
 * 画素1つ分の段々(ジャギー)になる。周囲4画素をメートルで線形補間して、境界をなめらかな線にする。
 * 非線形のまま補間すると手前側へ偏るので、必ずメートルに直してから混ぜる
 */
const FRAGMENT = `
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;
uniform float dataNear;
uniform float dataFar;
uniform float renderNear;
uniform float renderFar;
uniform float depthBias;

float toMeters( float d, float n, float f ) {
	if ( f <= 0.0 ) return n / max( 1.0 - d, 1e-6 );
	return n * f / ( f - d * ( f - n ) );
}

float toDepth( float z, float n, float f ) {
	if ( f <= 0.0 ) return 1.0 - n / z;
	return f * ( z - n ) / ( z * ( f - n ) );
}

// 何も取れていない画素(遠すぎる・センサー外)は、遮らないよう十分遠い扱いにする
const float NO_DEPTH = 1000.0;

float metersAt( ivec2 p, int layer, ivec2 size ) {
	float d = texelFetch( depthColor, ivec3( clamp( p, ivec2( 0 ), size - 1 ), layer ), 0 ).r;
	return d >= 1.0 ? NO_DEPTH : toMeters( d, dataNear, dataFar );
}

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );
	int layer = coord.x >= 1.0 ? 1 : 0;
	if ( layer == 1 ) coord.x -= 1.0;

	ivec2 size = textureSize( depthColor, 0 ).xy;
	vec2 st = coord * vec2( size ) - 0.5;
	ivec2 p = ivec2( floor( st ) );
	vec2 f = fract( st );
	float meters = mix(
		mix( metersAt( p, layer, size ), metersAt( p + ivec2( 1, 0 ), layer, size ), f.x ),
		mix( metersAt( p + ivec2( 0, 1 ), layer, size ), metersAt( p + ivec2( 1, 1 ), layer, size ), f.x ),
		f.y
	);

	if ( meters >= NO_DEPTH * 0.5 ) discard;
	gl_FragDepth = clamp( toDepth( meters + depthBias, renderNear, renderFar ), 0.0, 1.0 );

}`;

const VERTEX = `
void main() {

	gl_Position = vec4( position.xy, 0.0, 1.0 );

}`;

/** far がこれ以上なら無限遠として扱う(浮動小数の桁落ちを避ける) */
const FAR_AS_INFINITE = 1000;
const farUniform = (far: number | undefined): number =>
  far !== undefined && Number.isFinite(far) && far < FAR_AS_INFINITE ? far : 0;

export class DepthOcclusion {
  private session: XRSession | null = null;
  private binding: DepthBinding | null = null;
  private readonly texture = new THREE.Texture();
  private boundTexture: WebGLTexture | null = null;
  private readonly mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.ShaderMaterial>;
  /** 診断の行。初めて深度が取れたときに埋まる */
  private infoLines: string[] | null = null;
  private infoTaken = false;
  private errorNoted = false;
  /** 許可された使い方と形式(診断用)。許可されていなければ null */
  description: string | null = null;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    scene: THREE.Scene,
  ) {
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(2, 2),
      new THREE.ShaderMaterial({
        vertexShader: VERTEX,
        fragmentShader: FRAGMENT,
        uniforms: {
          depthColor: { value: this.texture },
          depthWidth: { value: 1 },
          depthHeight: { value: 1 },
          dataNear: { value: 0.1 },
          dataFar: { value: 0 },
          renderNear: { value: 0.1 },
          renderFar: { value: 0 },
          depthBias: { value: DEPTH_BIAS_METERS },
        },
        colorWrite: false,
        // 深度テストを切ると深度も書かれないので、テストは常に通す形にする
        depthFunc: THREE.AlwaysDepth,
      }),
    );
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -100; // アバター(と平面オクルーダー)より先に描いて深度を確定させる
    this.mesh.visible = false;
    scene.add(this.mesh);
  }

  /**
   * セッション開始直後、**renderer.xr.setSession より前に**呼ぶ。
   * 深度が許可されていれば、three.js から見えないよう enabledFeatures から外す
   */
  start(session: XRSession): void {
    const s = session as unknown as {
      enabledFeatures?: readonly string[];
      depthUsage?: string;
      depthDataFormat?: string;
    };
    if (!s.enabledFeatures?.includes('depth-sensing')) return;
    this.session = session;
    this.description = `${s.depthUsage ?? '?'} / ${s.depthDataFormat ?? '?'}`;
    Object.defineProperty(session, 'enabledFeatures', {
      value: s.enabledFeatures.filter((feature) => feature !== 'depth-sensing'),
      configurable: true,
    });
  }

  /** 毎フレーム呼ぶ(描画の前)。深度が取れなければメッシュを消しておく */
  update(frame: XRFrame): void {
    this.mesh.visible = false;
    if (!this.session) return;
    const refSpace = this.renderer.xr.getReferenceSpace();
    const view = refSpace ? frame.getViewerPose(refSpace)?.views[0] : undefined;
    if (!view) return;

    let info: DepthInfoLike | null | undefined;
    try {
      this.binding ??= new XRWebGLBinding(
        this.session,
        this.renderer.getContext(),
      ) as unknown as DepthBinding;
      info = this.binding.getDepthInformation?.(view);
    } catch (error) {
      if (!this.errorNoted) {
        this.errorNoted = true;
        this.infoLines = [`深度の取得でエラー: ${String(error).slice(0, 60)}`];
        console.warn('[ar depth]', error);
      }
      return;
    }
    if (!info || info.isValid === false || !info.texture) return;

    if (!this.infoTaken) {
      this.infoTaken = true;
      this.infoLines = this.describe(info, frame);
      console.log('[ar depth]', this.infoLines.join(' / '));
    }
    // 2Dテクスチャ(Android の形)はビューごとに別テクスチャなので、このシェーダでは扱えない
    if (info.textureType !== undefined && info.textureType !== 'texture-array') return;

    if (info.texture !== this.boundTexture) {
      // three.js の WebXRDepthSensing と同じく、外から来た WebGLTexture を Texture に差し込む
      const props = this.renderer.properties.get(this.texture) as { __webglTexture?: WebGLTexture };
      props.__webglTexture = info.texture;
      this.boundTexture = info.texture;
    }
    const state = frame.session.renderState;
    const viewport = this.renderer.xr.getCamera().cameras[0]?.viewport;
    if (!viewport) return;
    const u = this.mesh.material.uniforms;
    u.depthWidth!.value = viewport.z;
    u.depthHeight!.value = viewport.w;
    u.dataNear!.value = info.depthNear ?? state.depthNear;
    u.dataFar!.value = farUniform(info.depthFar ?? state.depthFar);
    u.renderNear!.value = state.depthNear;
    u.renderFar!.value = farUniform(state.depthFar);
    this.mesh.visible = true;
  }

  /** 診断の行を一度だけ受け取る(まだ深度が来ていなければ null) */
  takeInfoLines(): string[] | null {
    const lines = this.infoLines;
    this.infoLines = null;
    return lines;
  }

  stop(): void {
    this.session = null;
    this.binding = null;
    this.boundTexture = null;
    this.infoLines = null;
    this.infoTaken = false;
    this.errorNoted = false;
    this.description = null;
    this.mesh.visible = false;
    // 差し込んだ WebGLTexture は端末のものなので、three.js 側の参照だけ外す
    this.renderer.properties.remove(this.texture);
  }

  private describe(info: DepthInfoLike, frame: XRFrame): string[] {
    const state = frame.session.renderState;
    const fmt = (v: number | undefined): string => (v === undefined ? '?' : String(+v.toFixed(4)));
    return [
      `深度: ${info.width}x${info.height} ${info.textureType ?? '?'} 層${info.imageIndex ?? '?'} 生値→m ${fmt(info.rawValueToMeters)}`,
      `深度 near/far: ${fmt(info.depthNear)} / ${fmt(info.depthFar)}`,
      `描画 near/far: ${fmt(state.depthNear)} / ${fmt(state.depthFar)}`,
    ];
  }
}
