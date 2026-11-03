/**
 * AR空間に浮かぶコメントフィード。
 * 直近のコメントをcanvasテクスチャのパネルに積んで表示する。ボタンは無いが
 * ArPanelとして扱えるので、設定パネルと同じくグリップで掴んで移動できる。
 */
import * as THREE from 'three';
import type { ArPanel } from './spatialUI';

const CANVAS_W = 460;
const CANVAS_H = 380;
const PANEL_W = 0.3; // メートル
const PANEL_H = (PANEL_W * CANVAS_H) / CANVAS_W;
const MAX_LINES = 7;
const FONT_PX = 26;
const LINE_H = 38;

export class SpatialChat implements ArPanel {
  readonly object: THREE.Group;
  arPlacement = { position: new THREE.Vector3(-0.5, 1.2, -0.75), yaw: 0.5 };

  private readonly mesh: THREE.Mesh;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly texture: THREE.CanvasTexture;
  private messages: string[] = [];
  /** ルーム設定でコメントを止めている間は、AR内にも出さない */
  private enabled = false;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = CANVAS_W;
    this.canvas.height = CANVAS_H;
    this.ctx = this.canvas.getContext('2d')!;
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

  push(text: string): void {
    // 長文は折り返してから行として積む(下が最新)
    for (const line of this.wrap(text)) this.messages.push(line);
    if (this.messages.length > MAX_LINES) this.messages = this.messages.slice(-MAX_LINES);
    this.redraw();
  }

  setHistory(texts: string[]): void {
    this.messages = [];
    for (const t of texts) for (const line of this.wrap(t)) this.messages.push(line);
    this.messages = this.messages.slice(-MAX_LINES);
    this.redraw();
  }

  private wrap(text: string): string[] {
    const ctx = this.ctx;
    ctx.font = `${FONT_PX}px sans-serif`;
    const maxWidth = CANVAS_W - 36;
    const lines: string[] = [];
    let line = '';
    for (const ch of text) {
      if (ctx.measureText(line + ch).width > maxWidth && line) {
        lines.push(line);
        line = ch;
      } else {
        line += ch;
      }
    }
    if (line) lines.push(line);
    return lines;
  }

  private redraw(): void {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, CANVAS_W, CANVAS_H);
    ctx.fillStyle = 'rgba(16,16,22,0.72)';
    roundRect(ctx, 0, 0, CANVAS_W, CANVAS_H, 20);
    ctx.fill();
    ctx.fillStyle = '#9fe0b5';
    ctx.font = 'bold 24px sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText('💬 コメント', 20, 32);

    ctx.font = `${FONT_PX}px sans-serif`;
    ctx.fillStyle = '#ffffff';
    // 下詰めで最新が一番下に来るように描く
    const startY = CANVAS_H - 24 - (this.messages.length - 1) * LINE_H;
    this.messages.forEach((line, i) => {
      ctx.fillText(line, 20, Math.max(64, startY + i * LINE_H));
    });
    this.texture.needsUpdate = true;
  }

  show(position: THREE.Vector3, quaternion: THREE.Quaternion): void {
    this.object.position.copy(position);
    this.object.quaternion.copy(quaternion);
    this.object.visible = this.enabled;
  }

  /** コメントの可否(ルーム設定)。止めたら表示中のフィードも消して隠す */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.setHistory([]);
      this.object.visible = false;
    }
  }

  hide(): void {
    this.object.visible = false;
  }

  get visible(): boolean {
    return this.object.visible;
  }

  // ボタンは無いので、面に当たったら index=-2(掴めるが押せない)
  raycast(raycaster: THREE.Raycaster): { index: number; distance: number } | null {
    if (!this.object.visible) return null;
    const hit = raycaster.intersectObject(this.mesh, false)[0];
    return hit ? { index: -2, distance: hit.distance } : null;
  }

  setHover(): void {
    /* コメントフィードにホバー表現は不要 */
  }

  activate(): void {
    /* ボタンなし */
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
