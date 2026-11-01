/**
 * 深度オクルージョン(WebXR Depth Sensing)。現実の人や家具がアバターより手前にあれば、アバターを隠す。
 *
 * 描画そのものは three.js が持っている。'depth-sensing' が gpu-optimized で許可されると、
 * WebXRManager が毎フレーム深度テクスチャを受け取り、色を描かず深度だけ書く全画面メッシュを
 * 最初に描く(WebXRDepthSensing.js)。ここでやるのは次の3つだけ。
 *
 * - **要求するかの判断**。three.js の描画は深度が「テクスチャ配列・深度バッファ形式」で来る前提で、
 *   これは Quest Browser の形。Android Chrome(ARCore)は2Dテクスチャ・ミリ単位で来るので噛み合わず、
 *   しかも許可された瞬間にフリーズする事例があった(ar.ts の注意書き)。既定では Quest でだけ要求する
 * - **奥行きの下駄**。センサーの深度は数cm揺れるうえ、床とアバターの足は同じ深さにある。
 *   そのままだと足元や体の表面がちらつくので、現実の深度を少し奥へずらしてから書く。
 *   誤差が「隠しすぎ」でなく「隠し足りない」側に倒れる(空中でアバターが欠けるほうが目立つ)
 * - 診断用に、許可された形式を返す
 */
import type * as THREE from 'three';

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

/** requestSession に足す設定。gpu-optimized だけを望む(three.js が使えるのはこれだけ) */
export const DEPTH_SENSING_INIT = {
  usagePreference: ['gpu-optimized'],
  // 空にすると形式はブラウザに任せる(Quest は深度バッファ形式を返す)
  dataFormatPreference: [],
} as const;

/** セッションで実際に許可された深度の使い方(診断用)。許可されていなければ null */
export function depthDescription(session: XRSession): string | null {
  const s = session as unknown as {
    enabledFeatures?: readonly string[];
    depthUsage?: string;
    depthDataFormat?: string;
  };
  if (!s.enabledFeatures?.includes('depth-sensing')) return null;
  return `${s.depthUsage ?? '?'} / ${s.depthDataFormat ?? '?'}`;
}

/**
 * 深度テクスチャの中身の手がかり(診断用)。three.js と同じく1つ目のビューの深度情報を引く。
 * 深度はセッション開始から少し遅れて届くので、取れるまでは null
 */
export function depthInfoLines(
  renderer: THREE.WebGLRenderer,
  frame: XRFrame,
  refSpace: XRReferenceSpace,
): string[] | null {
  // @types/webxr の型は depthNear/depthFar を持たないので、読む分だけの形で受ける
  const binding = renderer.xr.getBinding() as unknown as {
    getDepthInformation?: (view: XRView) => DepthInfoLike | null;
  };
  const view = frame.getViewerPose(refSpace)?.views[0];
  const info = view ? binding.getDepthInformation?.(view) : null;
  if (!info) return null;
  const state = frame.session.renderState;
  const camera = renderer.xr.getCamera();
  const fmt = (v: number | undefined): string => (v === undefined ? '?' : String(+v.toFixed(4)));
  return [
    `深度: ${info.width}x${info.height} ${info.textureType ?? '?'} 層${info.imageIndex ?? '?'} 生値→m ${fmt(info.rawValueToMeters)}`,
    `深度 near/far: ${fmt(info.depthNear)} / ${fmt(info.depthFar)}`,
    `描画 near/far: ${fmt(state.depthNear)} / ${fmt(state.depthFar)} カメラ ${fmt(camera.near)} / ${fmt(camera.far)}`,
  ];
}

interface DepthInfoLike {
  width: number;
  height: number;
  rawValueToMeters?: number;
  /** 'texture' か 'texture-array' */
  textureType?: string;
  imageIndex?: number;
  depthNear?: number;
  depthFar?: number;
}

/**
 * three.js の深度書き込みに下駄を履かせる。
 *
 * 深度テクスチャの値は深度バッファと同じ非線形の [0, 1] なので、一度メートルへ戻して
 * ずらしてから戻す。near/far は three.js がカメラへ移した深度の値(WebXRManager)を使う。
 * far が無限大(またはそれに近い)なら無限遠の投影として扱う
 */
const BIASED_FRAGMENT = `
uniform sampler2DArray depthColor;
uniform float depthWidth;
uniform float depthHeight;
uniform float depthNear;
uniform float depthFar;
uniform float depthBias;

float toMeters( float d ) {
	if ( depthFar <= 0.0 ) return depthNear / max( 1.0 - d, 1e-6 );
	return depthNear * depthFar / ( depthFar - d * ( depthFar - depthNear ) );
}

float toDepth( float z ) {
	if ( depthFar <= 0.0 ) return 1.0 - depthNear / z;
	return depthFar * ( z - depthNear ) / ( z * ( depthFar - depthNear ) );
}

void main() {

	vec2 coord = vec2( gl_FragCoord.x / depthWidth, gl_FragCoord.y / depthHeight );
	float d = coord.x >= 1.0
		? texture( depthColor, vec3( coord.x - 1.0, coord.y, 1 ) ).r
		: texture( depthColor, vec3( coord.x, coord.y, 0 ) ).r;

	// 何も取れていない画素(遠すぎる・センサー外)は遮らない
	if ( d >= 1.0 ) discard;
	gl_FragDepth = clamp( toDepth( toMeters( d ) + depthBias ), 0.0, 1.0 );

}`;

/**
 * `?depthshader=three` なら three.js の元のシェーダのまま使う(検証用)。
 * 下駄の変換が悪いのか、深度の受け取り自体が噛み合っていないのかを切り分ける
 */
const KEEP_THREE_SHADER = new URLSearchParams(location.search).get('depthshader') === 'three';

/** far がこれ以上なら無限遠として扱う(浮動小数の桁落ちを避ける) */
const FAR_AS_INFINITE = 1000;

/**
 * 毎フレーム呼ぶ。three.js の深度メッシュが出来ていれば、一度だけ下駄付きのシェーダへ差し替え、
 * near/far を追従させる。深度が来ていなければ何もしない
 */
export function updateDepthOcclusion(renderer: THREE.WebGLRenderer): void {
  const xr = renderer.xr as THREE.WebXRManager & {
    hasDepthSensing?: () => boolean;
    getDepthSensingMesh?: () => THREE.Mesh | null;
  };
  if (KEEP_THREE_SHADER || !xr.hasDepthSensing?.()) return;
  const mesh = xr.getDepthSensingMesh?.();
  if (!mesh) return;
  const material = mesh.material as THREE.ShaderMaterial;
  if (material.fragmentShader !== BIASED_FRAGMENT) {
    material.fragmentShader = BIASED_FRAGMENT;
    material.uniforms.depthNear = { value: 0.1 };
    material.uniforms.depthFar = { value: 0 };
    material.uniforms.depthBias = { value: DEPTH_BIAS_METERS };
    material.needsUpdate = true;
  }
  const camera = xr.getCamera();
  material.uniforms.depthNear!.value = camera.near;
  material.uniforms.depthFar!.value =
    Number.isFinite(camera.far) && camera.far < FAR_AS_INFINITE ? camera.far : 0;
}
