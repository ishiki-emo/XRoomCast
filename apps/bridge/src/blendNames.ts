/**
 * VRM 0.xのブレンドシェイプ名 → VRM 1.0の表情プリセット名への正規化。
 * VSeeFace(VRM 0.xアバター)は旧名で送ってくるが、ビューア(three-vrm)は
 * expressionManagerにVRM 1.0名で登録するため、ワイヤ上は1.0名に統一する。
 * 未知の名前(カスタムクリップ)はそのまま通す。
 */
const VRM0_TO_VRM1 = new Map<string, string>([
  ['neutral', 'neutral'],
  ['joy', 'happy'],
  ['angry', 'angry'],
  ['sorrow', 'sad'],
  ['fun', 'relaxed'],
  ['surprised', 'surprised'],
  ['a', 'aa'],
  ['i', 'ih'],
  ['u', 'ou'],
  ['e', 'ee'],
  ['o', 'oh'],
  ['blink', 'blink'],
  ['blink_l', 'blinkLeft'],
  ['blink_r', 'blinkRight'],
  ['lookup', 'lookUp'],
  ['lookdown', 'lookDown'],
  ['lookleft', 'lookLeft'],
  ['lookright', 'lookRight'],
]);

export function normalizeBlendName(name: string): string {
  return VRM0_TO_VRM1.get(name.toLowerCase()) ?? name;
}
