/**
 * 空間に置ける設定パネル(AR用)。
 * canvasテクスチャを貼ったプレーンで、コントローラのレイが当たったボタンを
 * ハイライトし、トリガーで選択する。パネル自体はグリップで掴んで移動できる。
 *
 * 設定項目が増えたため複数セクションを1枚にまとめられる構造にしている
 * (パネルを何枚も浮かべると視界が埋まるため)。
 */
import * as THREE from 'three';

/** AR空間に置けるパネルの共通インターフェース(掴み移動・レイ操作の対象) */
export interface ArPanel {
  readonly object: THREE.Object3D;
  readonly visible: boolean;
  /** AR開始時の初期配置 */
  arPlacement: { position: THREE.Vector3; yaw: number };
  /** レイとの交差。index: >=0 ボタン / -2 面(ボタン外) / なければ null */
  raycast(raycaster: THREE.Raycaster): { index: number; distance: number } | null;
  setHover(index: number): void;
  activate(index: number): void;
  show(position: THREE.Vector3, quaternion: THREE.Quaternion): void;
  hide(): void;
}

export interface PanelOption {
  label: string;
  value: string;
  /** 選択状態を持たない実行ボタン(押しても●印は付かない) */
  action?: boolean;
}

export interface PanelSection {
  title: string;
  options: PanelOption[];
  /** 1行に並べるボタンの数(既定1)。短いラベルのボタンが多い欄を詰めて並べる */
  columns?: number;
  initial: string;
  onSelect: (value: string) => void;
}

export interface PanelSpec {
  title: string;
  sections: PanelSection[];
}

const CANVAS_W = 512;
const PANEL_W = 0.34; // メートル
const PAD = 24;
const HEADER_H = 64;
const SECTION_TITLE_H = 40;
const BUTTON_H = 52;
const BUTTON_GAP = 12;
const SECTION_GAP = 18;

interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
  option: PanelOption;
  section: number;
}

export class SpatialPanel implements ArPanel {
  readonly object: THREE.Group;
  arPlacement = { position: new THREE.Vector3(0.45, 1.15, -0.7), yaw: -0.5 };
  private readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly buttons: ButtonRect[] = [];
  private readonly sectionTitleY: number[] = [];
  private readonly canvasHeight: number;
  /** セクションごとの選択値 */
  private readonly active: string[];
  private hover = -1;

  constructor(private readonly spec: PanelSpec) {
    this.active = spec.sections.map((section) => section.initial);

    // レイアウトを先に確定させてキャンバス高さを決める
    let y = HEADER_H;
    spec.sections.forEach((section, sectionIndex) => {
      this.sectionTitleY.push(y);
      y += SECTION_TITLE_H;
      const columns = Math.max(1, section.columns ?? 1);
      const width = (CANVAS_W - PAD * 2 - BUTTON_GAP * (columns - 1)) / columns;
      section.options.forEach((option, i) => {
        const column = i % columns;
        this.buttons.push({
          x: PAD + column * (width + BUTTON_GAP),
          y,
          w: width,
          h: BUTTON_H,
          option,
          section: sectionIndex,
        });
        // 行の最後のボタン(か、欄の最後)で次の行へ
        if (column === columns - 1 || i === section.options.length - 1) y += BUTTON_H + BUTTON_GAP;
      });
      y += SECTION_GAP - BUTTON_GAP;
    });
    this.canvasHeight = y + PAD;

    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = this.canvasHeight;
    this.ctx = this.canvas.getContext('2d')!;

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_W, (PANEL_W * this.canvasHeight) / CANVAS_W),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }),
    );
    this.object = new THREE.Group();
    this.object.add(this.mesh);
    this.object.visible = false;
    this.redraw();
  }

  private redraw(): void {
    const ctx = this.ctx;
    const height = this.canvasHeight;
    ctx.clearRect(0, 0, CANVAS_W, height);
    // 背景
    ctx.fillStyle = 'rgba(20,20,26,0.92)';
    roundRect(ctx, 0, 0, CANVAS_W, height, 24);
    ctx.fill();
    // パネルタイトル
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.spec.title, 26, 40);

    // セクション見出し
    this.spec.sections.forEach((section, i) => {
      const titleY = this.sectionTitleY[i]!;
      ctx.fillStyle = '#8fd0ff';
      ctx.font = 'bold 25px sans-serif';
      ctx.fillText(section.title, 26, titleY + SECTION_TITLE_H / 2 - 2);
    });

    // ボタン
    this.buttons.forEach((b, i) => {
      const isActive = !b.option.action && b.option.value === this.active[b.section];
      const isHover = i === this.hover;
      ctx.fillStyle = isActive ? '#3a6f4a' : isHover ? '#3a3a44' : '#2a2a32';
      roundRect(ctx, b.x, b.y, b.w, b.h, 14);
      ctx.fill();
      if (isHover) {
        ctx.strokeStyle = '#8fd0ff';
        ctx.lineWidth = 3;
        ctx.stroke();
      }
      ctx.fillStyle = isActive ? '#bff0cf' : '#eeeeee';
      const label = (isActive ? '● ' : '') + b.option.label;
      if (b.w < CANVAS_W - PAD * 2) {
        // 並べたボタンは幅が狭いので、文字を小さくして中央に置く
        ctx.font = '25px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(label, b.x + b.w / 2, b.y + b.h / 2);
        ctx.textAlign = 'left';
      } else {
        ctx.font = '28px sans-serif';
        ctx.fillText(label, b.x + 22, b.y + b.h / 2);
      }
    });
    this.texture.needsUpdate = true;
  }

  show(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.object.position.copy(position);
    this.object.quaternion.copy(quaternion);
    this.object.visible = true;
  }

  hide(): void {
    this.object.visible = false;
    this.setHover(-1);
  }

  get visible(): boolean {
    return this.object.visible;
  }

  /** レイとパネルの交差からボタンindexを返す(当たらなければ-1、パネルには当たるが
   *  ボタン外なら-2)。距離も返してレーザー描画に使う */
  raycast(raycaster: THREE.Raycaster): { index: number; distance: number } | null {
    if (!this.object.visible) return null;
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    if (!hit || !hit.uv) return null;
    const cx = hit.uv.x * CANVAS_W;
    const cy = (1 - hit.uv.y) * this.canvasHeight;
    const index = this.buttons.findIndex(
      (b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h,
    );
    return { index: index >= 0 ? index : -2, distance: hit.distance };
  }

  setHover(index: number): void {
    if (this.hover === index) return;
    this.hover = index;
    this.redraw();
  }

  activate(index: number): void {
    const button = this.buttons[index];
    if (!button) return;
    if (!button.option.action) this.active[button.section] = button.option.value;
    this.redraw();
    this.spec.sections[button.section]!.onSelect(button.option.value);
  }

  /** 外部(画面側UI・ピンチ操作など)で変わった選択状態を反映する */
  setActive(value: string): void {
    for (let i = 0; i < this.spec.sections.length; i += 1) {
      const owns = this.spec.sections[i]!.options.some((o) => !o.action && o.value === value);
      // 空文字などどのセクションにも属さない値は「選択なし」として扱う
      if (!owns) continue;
      if (this.active[i] === value) return;
      this.active[i] = value;
      this.redraw();
      return;
    }
  }

  /** セクション見出しを差し替える(現在値を見出しに出したいとき用) */
  setSectionTitle(index: number, title: string): void {
    const section = this.spec.sections[index];
    if (!section || section.title === title) return;
    section.title = title;
    this.redraw();
  }

  /** 指定セクションの選択を外す(どのプリセットにも一致しない状態の表現) */
  clearActive(sectionTitle: string): void {
    const index = this.spec.sections.findIndex((s) => s.title === sectionTitle);
    if (index < 0 || this.active[index] === '') return;
    this.active[index] = '';
    this.redraw();
  }
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
