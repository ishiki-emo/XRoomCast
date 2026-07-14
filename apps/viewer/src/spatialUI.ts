/**
 * 空間に置ける設定パネル(AR用)。
 * canvasテクスチャを貼ったプレーンで、コントローラのレイが当たったボタンを
 * ハイライトし、トリガーで選択する。パネル自体はグリップで掴んで移動できる。
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
}

export interface PanelSpec {
  title: string;
  options: PanelOption[];
  initial: string;
  onSelect: (value: string) => void;
}

const CANVAS_W = 512;
const CANVAS_H = 300;
const PANEL_W = 0.34; // メートル
const PANEL_H = (PANEL_W * CANVAS_H) / CANVAS_W;

interface ButtonRect {
  x: number;
  y: number;
  w: number;
  h: number;
  option: PanelOption;
}

export class SpatialPanel implements ArPanel {
  readonly object: THREE.Group;
  arPlacement = { position: new THREE.Vector3(0.45, 1.15, -0.7), yaw: -0.5 };
  private readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private readonly buttons: ButtonRect[] = [];
  private active: string;
  private hover = -1;

  constructor(private readonly spec: PanelSpec) {
    this.active = spec.initial;
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;

    // ボタンレイアウト(縦積み。押しやすいよう大きめ)
    const pad = 24;
    const top = 92;
    const gap = 16;
    const bh = 56;
    const bw = CANVAS_W - pad * 2;
    this.spec.options.forEach((option, i) => {
      this.buttons.push({ x: pad, y: top + i * (bh + gap), w: bw, h: bh, option });
    });

    this.texture = new THREE.CanvasTexture(this.canvas);
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(PANEL_W, PANEL_H),
      new THREE.MeshBasicMaterial({ map: this.texture, transparent: true }),
    );
    this.object = new THREE.Group();
    this.object.add(this.mesh);
    this.object.visible = false;
    this.redraw();
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    // 背景
    ctx.fillStyle = 'rgba(20,20,26,0.92)';
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 24);
    ctx.fill();
    // タイトル
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 34px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(this.spec.title, 26, 48);
    // ボタン
    this.buttons.forEach((b, i) => {
      const isActive = b.option.value === this.active;
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
      ctx.font = '30px sans-serif';
      ctx.fillText((isActive ? '● ' : '') + b.option.label, b.x + 22, b.y + b.h / 2);
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
    const cy = (1 - hit.uv.y) * CANVAS_H;
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
    this.active = button.option.value;
    this.redraw();
    this.spec.onSelect(button.option.value);
  }

  setActive(value: string): void {
    if (this.active === value) return;
    this.active = value;
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
