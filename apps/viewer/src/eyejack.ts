/**
 * iPhone・iPad で AR を見るための EyeJack X 経由のURL。
 * iOS の Safari は WebXR の AR に対応していないので、EyeJack X(App Clip で動く
 * WebXR の代わり)にページを開いてもらう。
 * **視聴URL専用**: 包んだURLは EyeJack のサーバーを通るので、配信者URLは決して包まない
 */
export function eyejackUrl(watchUrl: string): string {
  return `https://play.eyejack.xyz/link/?url=${encodeURIComponent(watchUrl)}`;
}

/** iPhone・iPad か(iPadOS の Safari は Mac を名乗るので、タッチの有無で見分ける) */
export function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}
