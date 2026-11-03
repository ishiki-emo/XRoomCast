/**
 * HMD配信の表情。VRChat のアバターと同じく、ハンドジェスチャーに表情を割り当てて切り替える。
 * HMD内の操作パネルから表情を選んで固定することもできる(選んでいる間はジェスチャーより優先)。
 *
 * - 割り当ては左右の手で別々に持つ。両手で表情のジェスチャーを出したら、後から出した方を優先
 * - グーの表情はトリガーの引き具合(GestureWeight)で強さが変わる(VRChat と同じ使い方)
 * - 表情はなめらかに切り替える(パッと変わると不自然に見えるため)
 * - 割り当てはこの端末のブラウザにだけ保存する(サーバーには送らない)
 */
import { GESTURE, type Gesture, type GestureReading } from './vrGestures';

const STORAGE_KEY = 'xroomcast.hmd.gestureExpressions';

/** ジェスチャー → 表情名(null は割り当てなし) */
export type GestureMap = Partial<Record<Gesture, string | null>>;

export interface GestureExpressionSettings {
  left: GestureMap;
  right: GestureMap;
}

/** VRMの標準の表情(パネルから選べるもの) */
export const PRESET_EXPRESSIONS = ['happy', 'angry', 'sad', 'relaxed', 'surprised'] as const;

/**
 * 既定の割り当て(左右同じ)。持っているだけで出やすいジェスチャー(グー・指差し・指鉄砲)は空けてある
 * (グーは物をつかむとき、指差し・指鉄砲はコントローラを握って親指を動かしたときに出やすい)
 */
const DEFAULT_MAP: GestureMap = {
  [GESTURE.handOpen]: 'surprised',
  [GESTURE.victory]: 'happy',
  [GESTURE.rockNRoll]: 'angry',
  [GESTURE.thumbsUp]: 'relaxed',
};

export function defaultGestureSettings(): GestureExpressionSettings {
  return { left: { ...DEFAULT_MAP }, right: { ...DEFAULT_MAP } };
}

function parseMap(value: unknown): GestureMap {
  const map: GestureMap = {};
  if (typeof value !== 'object' || value === null) return map;
  for (const [key, name] of Object.entries(value)) {
    const gesture = Number(key);
    if (!Number.isInteger(gesture) || gesture < 1 || gesture > 7) continue;
    if (name === null || (typeof name === 'string' && name.length <= 64)) {
      map[gesture as Gesture] = name;
    }
  }
  return map;
}

export function loadGestureSettings(): GestureExpressionSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultGestureSettings();
    const value = JSON.parse(raw) as Record<string, unknown>;
    return { left: parseMap(value.left), right: parseMap(value.right) };
  } catch {
    return defaultGestureSettings();
  }
}

export function saveGestureSettings(settings: GestureExpressionSettings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // 覚えられないだけ
  }
}

/** 表情が0から1まで変わるのにかける時間(秒) */
const FADE_SECONDS = 0.15;

export class GestureExpressionMixer {
  private settings: GestureExpressionSettings = loadGestureSettings();
  private readonly previous: Record<'left' | 'right', Gesture> = {
    left: GESTURE.neutral,
    right: GESTURE.neutral,
  };
  /** 最後に表情のジェスチャーを出した手 */
  private latest: 'left' | 'right' | null = null;
  /** パネルで選んで固定した表情(null はジェスチャーで切り替える) */
  private override: string | null = null;
  private readonly values = new Map<string, number>();

  get currentSettings(): Readonly<GestureExpressionSettings> {
    return this.settings;
  }

  /** 配信者ページで割り当てを変えたとき */
  setSettings(settings: GestureExpressionSettings): void {
    this.settings = settings;
    saveGestureSettings(settings);
  }

  /** パネルで表情を選ぶ(null でジェスチャーに戻す) */
  setOverride(expression: string | null): void {
    this.override = expression;
  }

  get overrideExpression(): string | null {
    return this.override;
  }

  /** 割り当て先とパネルの表情を合わせた、送る可能性のある表情の名前 */
  expressionNames(): string[] {
    const names = new Set<string>(PRESET_EXPRESSIONS);
    for (const map of [this.settings.left, this.settings.right]) {
      for (const name of Object.values(map)) if (name) names.add(name);
    }
    return [...names];
  }

  /**
   * 両手のジェスチャーから、いまの表情の値を出す。delta は前回からの秒数。
   * 戻り値は、表情名 → 0..1(出していない表情も0で入る)
   */
  update(
    readings: Record<'left' | 'right', GestureReading>,
    delta: number,
  ): ReadonlyMap<string, number> {
    for (const side of ['left', 'right'] as const) {
      const gesture = readings[side].gesture;
      if (gesture !== this.previous[side] && this.settings[side][gesture]) this.latest = side;
      this.previous[side] = gesture;
    }

    let target: string | null = null;
    let weight = 1;
    if (this.override) {
      target = this.override;
    } else {
      // 後から出した手を優先し、その手が表情のジェスチャーをやめたら、もう片方を見る
      const order: ('left' | 'right')[] =
        this.latest === 'right' ? ['right', 'left'] : ['left', 'right'];
      for (const side of order) {
        const reading = readings[side];
        const name = this.settings[side][reading.gesture];
        if (!name) continue;
        target = name;
        weight = reading.gesture === GESTURE.fist ? reading.weight : 1;
        break;
      }
    }

    const step = delta / FADE_SECONDS;
    for (const name of this.expressionNames()) {
      const goal = name === target ? weight : 0;
      const current = this.values.get(name) ?? 0;
      const next = goal > current ? Math.min(goal, current + step) : Math.max(goal, current - step);
      this.values.set(name, next);
    }
    return this.values;
  }
}
