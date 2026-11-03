/**
 * VRの視界の左下に出すマイクの表示(メニューを開かなくても、いまミュートかどうかが分かるように)。
 *
 * - ミュート中: 赤で「ミュート中」と出し続ける
 * - マイクオン: 声に合わせて明るくなる。目に優しいよう、明るさは声の大きさをならしてゆっくり変える
 *   (立ち上がりは速め、消えるのはゆっくり)
 *
 * 頭に合わせて毎フレーム置き直す(カメラの子にすると、XRのカメラの更新が描画の後になって1フレーム遅れ、揺れて見える)。
 * 鏡に映らないよう、専用のレイヤーにだけ載せる
 */
import * as THREE from 'three';

/** 表示を載せるレイヤー。目のカメラだけで描き、鏡のカメラでは描かない */
export const HUD_LAYER = 11;

/** 頭から見た置き場所(m)。左下の、視界の端に入る程度(正面から左へ約17°・下へ約15°) */
const OFFSET = new THREE.Vector3(-0.17, -0.15, -0.55);
const WIDTH = 0.1;
const CANVAS_W = 256;
const CANVAS_H = 80;
/** 声の明るさが追いつくまでの時間(秒)。立ち上がりは速く、消えるのはゆっくり */
const RISE = 0.08;
const FALL = 0.45;
/** この大きさで最も明るくなる(リップシンクの母音の重みの合計) */
const FULL_LEVEL = 0.6;
/** 声が無いときの明るさ(消えてしまうと、オンなのかどうか分からない) */
const IDLE_OPACITY = 0.35;

const _offset = new THREE.Vector3();
const COLOR_IDLE = new THREE.Color('#ffffff');
const COLOR_VOICE = new THREE.Color('#7dffa8');

export class MicHud {
  readonly object: THREE.Mesh;
  private readonly material: THREE.MeshBasicMaterial;
  private readonly textures: { on: THREE.CanvasTexture; muted: THREE.CanvasTexture };
  private muted = true;
  private glow = 0;

  constructor() {
    this.textures = {
      on: drawLabel('🎙 マイク', '#ffffff', 'rgba(20,20,26,0.75)'),
      muted: drawLabel('🔇 ミュート中', '#ffffff', 'rgba(170,30,40,0.85)'),
    };
    this.material = new THREE.MeshBasicMaterial({
      map: this.textures.muted,
      transparent: true,
      depthTest: false,
      depthWrite: false,
    });
    this.object = new THREE.Mesh(
      new THREE.PlaneGeometry(WIDTH, (WIDTH * CANVAS_H) / CANVAS_W),
      this.material,
    );
    // 何よりも手前に描く(アバターの体や手に隠れないように)
    this.object.renderOrder = 1000;
    this.object.layers.set(HUD_LAYER);
    this.object.visible = false;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    this.material.map = muted ? this.textures.muted : this.textures.on;
    this.material.needsUpdate = true;
  }

  hide(): void {
    this.object.visible = false;
  }

  /**
   * 毎フレーム呼ぶ。head: 頭の位置と向き(シーンの座標)。level: 声の大きさ(マイクが無いときは0)
   */
  update(head: XRRigidTransform, level: number, delta: number): void {
    const p = head.position;
    const q = head.orientation;
    this.object.quaternion.set(q.x, q.y, q.z, q.w);
    this.object.position
      .set(p.x, p.y, p.z)
      .add(_offset.copy(OFFSET).applyQuaternion(this.object.quaternion));
    this.object.visible = true;

    if (this.muted) {
      this.glow = 0;
      this.material.opacity = 0.9;
      this.material.color.copy(COLOR_IDLE);
      return;
    }
    const target = Math.min(1, level / FULL_LEVEL);
    const time = target > this.glow ? RISE : FALL;
    this.glow += (target - this.glow) * Math.min(1, delta / time);
    this.material.opacity = IDLE_OPACITY + (1 - IDLE_OPACITY) * this.glow;
    this.material.color.copy(COLOR_IDLE).lerp(COLOR_VOICE, this.glow);
  }
}

function drawLabel(text: string, color: string, background: string): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = background;
  ctx.beginPath();
  ctx.roundRect(0, 0, CANVAS_W, CANVAS_H, 24);
  ctx.fill();
  ctx.fillStyle = color;
  ctx.font = 'bold 34px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, CANVAS_W / 2, CANVAS_H / 2 + 2);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}
