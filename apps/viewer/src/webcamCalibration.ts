/**
 * Webカメラ配信の個人設定(このブラウザにだけ保存し、サーバーには送らない)。
 *
 * - 普通の顔(基準): 目を開けていても残る値など、人ごとの癖を引くための基準。
 *   登録すると、まばたき・口の誤反応(意図しないウインクなど)が減る
 * - 表情の型: 「この顔をしたら VRM のこの表情」。登録した顔と、いまの顔の近さで表情の強さを決める
 *   (VSeeFace の「表情の検出」と同じ考え方)
 * - 滑らかさ・手の推定のオン/オフ
 *
 * 書き出し・読み込み(JSON)で、別のPCへ持っていける
 */

const STORAGE_KEY = 'xroomcast.webcam.calibration';

/** ブレンドシェイプ名 → 値(0..1) */
export type Shape = Record<string, number>;

export interface ExpressionTemplate {
  /** 割り当てる VRM の表情名(happy・angry・モデル独自の表情など) */
  target: string;
  /** その顔をしたときのブレンドシェイプ(登録時の数秒の平均) */
  shape: Shape;
}

export interface WebcamSettings {
  /** 普通の顔。null は未登録 */
  neutral: Shape | null;
  templates: ExpressionTemplate[];
  /** 滑らかさ(0=反応が速い 〜 1=滑らか) */
  smoothing: number;
  /** 手も推定するか(カメラ1台では奥行きが取れず暴れやすいので、既定はオフ) */
  hands: boolean;
}

export const DEFAULT_SETTINGS: WebcamSettings = {
  neutral: null,
  templates: [],
  smoothing: 0.5,
  hands: false,
};

function isShape(value: unknown): value is Shape {
  return (
    typeof value === 'object' &&
    value !== null &&
    Object.values(value).every((v) => typeof v === 'number' && Number.isFinite(v))
  );
}

/** 保存・読み込みした値を検証して設定へ(壊れた値や未知のキーは無視する) */
export function parseSettings(value: unknown): WebcamSettings {
  const settings: WebcamSettings = { ...DEFAULT_SETTINGS, templates: [] };
  if (typeof value !== 'object' || value === null) return settings;
  const v = value as Record<string, unknown>;
  if (isShape(v.neutral)) settings.neutral = v.neutral;
  if (Array.isArray(v.templates)) {
    for (const t of v.templates as unknown[]) {
      const template = t as Record<string, unknown>;
      if (typeof template.target === 'string' && template.target && isShape(template.shape)) {
        settings.templates.push({ target: template.target.slice(0, 64), shape: template.shape });
      }
    }
  }
  if (typeof v.smoothing === 'number' && v.smoothing >= 0 && v.smoothing <= 1) {
    settings.smoothing = v.smoothing;
  }
  if (typeof v.hands === 'boolean') settings.hands = v.hands;
  return settings;
}

export function loadSettings(): WebcamSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseSettings(JSON.parse(raw)) : { ...DEFAULT_SETTINGS, templates: [] };
  } catch {
    // 保存できない環境(プライベートウィンドウ等)や壊れた値は、既定で動かす
    return { ...DEFAULT_SETTINGS, templates: [] };
  }
}

export function saveSettings(settings: WebcamSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 覚えられないだけ(このページを開いている間は使える)
  }
}

/**
 * 普通の顔を引いた値。基準より大きいぶんだけを、残りの幅(1 - 基準)で 0..1 に引き直す。
 * 基準が未登録ならそのまま
 */
export function relativeToNeutral(
  shapes: ReadonlyMap<string, number>,
  neutral: Shape | null,
): Shape {
  const out: Shape = {};
  for (const [name, value] of shapes) {
    const base = neutral?.[name] ?? 0;
    out[name] = base >= 0.99 ? 0 : Math.max(0, (value - base) / (1 - base));
  }
  return out;
}

/**
 * 登録した型がいまの顔にどれだけ出ているか(0..1)。どちらも普通の顔を引いた値で比べる。
 * - 量: いまの顔を型の向きへ射影した長さ ÷ 型の長さ(型と同じ顔なら1)
 * - 似かた: 向きの近さ(コサイン)。型と違う顔(別の表情)で量だけ増えないよう、二乗して掛ける
 */
export function templateWeight(current: Shape, template: Shape): number {
  let dot = 0;
  let templateSq = 0;
  let currentSq = 0;
  for (const name in template) {
    const t = template[name]!;
    const c = current[name] ?? 0;
    dot += t * c;
    templateSq += t * t;
  }
  for (const name in current) currentSq += current[name]! ** 2;
  if (templateSq < 1e-6 || currentSq < 1e-6) return 0;
  const amount = dot / templateSq;
  const cosine = dot / Math.sqrt(templateSq * currentSq);
  const weight = Math.min(1, Math.max(0, amount)) * Math.max(0, cosine) ** 2;
  // 少しだけ似ているときは出さず、はっきりしたら最大まで出す
  return Math.min(1, Math.max(0, (weight - 0.2) / 0.5));
}

/** 数秒間のブレンドシェイプを平均して1つの型にする(登録用) */
export class ShapeRecorder {
  private readonly sums = new Map<string, number>();
  private count = 0;

  add(shapes: ReadonlyMap<string, number> | Shape): void {
    const entries = shapes instanceof Map ? shapes.entries() : Object.entries(shapes);
    for (const [name, value] of entries) this.sums.set(name, (this.sums.get(name) ?? 0) + value);
    this.count++;
  }

  get samples(): number {
    return this.count;
  }

  result(): Shape {
    const shape: Shape = {};
    // 値が小さすぎる項目は、型の向きをぼかすだけなので落とす(保存量も減る)
    for (const [name, sum] of this.sums) {
      const mean = sum / Math.max(1, this.count);
      if (mean >= 0.02) shape[name] = Math.round(mean * 1000) / 1000;
    }
    return shape;
  }
}
