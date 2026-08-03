/**
 * アバターに追従する接地影(AR用)。3モード切り替え可能:
 * - 'full': ShadowMaterial+影専用ライトによる「形のある影」(シャドウマップ使用)
 * - 'blob': ぼかし楕円テクスチャの疑似影(追加描画パスなし=最軽量)
 * - 'off' : なし
 * すべて avatarRoot の子なので設置・つかみ・卓上スケールに追従する。
 */
import * as THREE from 'three';

export type ShadowMode = 'off' | 'blob' | 'full';

function makeBlobTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(0,0,0,0.55)');
  gradient.addColorStop(0.6, 'rgba(0,0,0,0.28)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class ContactShadow {
  private readonly light: THREE.DirectionalLight;
  private readonly target = new THREE.Object3D();
  private readonly fullPlane: THREE.Mesh;
  private readonly blobPlane: THREE.Mesh;

  private mode: ShadowMode = 'full';
  private arActive = false;
  private frame = 0;

  constructor(avatarRoot: THREE.Object3D) {
    // 「形のある影」用: 強度0でも castShadow=true なら影は落ちる
    this.light = new THREE.DirectionalLight(0xffffff, 0);
    this.light.position.set(0.4, 3, 0.7);
    this.light.castShadow = true;
    this.light.shadow.mapSize.set(512, 512);
    const cam = this.light.shadow.camera;
    cam.left = -1.3;
    cam.right = 1.3;
    cam.top = 1.3;
    cam.bottom = -1.3;
    cam.near = 0.1;
    cam.far = 6;
    this.light.shadow.bias = -0.0005;
    this.light.target = this.target;
    this.light.shadow.autoUpdate = false; // 更新は間引く(update()参照)

    this.fullPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    this.fullPlane.position.y = 0.001;
    this.fullPlane.receiveShadow = true;

    // 疑似影: ぼかし楕円テクスチャ(足の前後に少し長い)。追加描画パスなし
    this.blobPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, 0.82).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({
        map: makeBlobTexture(),
        transparent: true,
        depthWrite: false,
        opacity: 1,
      }),
    );
    this.blobPlane.position.y = 0.002;
    this.blobPlane.renderOrder = 1;

    avatarRoot.add(this.target, this.light, this.fullPlane, this.blobPlane);
    this.apply();
  }

  setARActive(on: boolean): void {
    this.arActive = on;
    this.frame = 0;
    this.apply();
  }

  setMode(mode: ShadowMode): void {
    this.mode = mode;
    this.apply();
  }

  getMode(): ShadowMode {
    return this.mode;
  }

  private apply(): void {
    const full = this.arActive && this.mode === 'full';
    const blob = this.arActive && this.mode === 'blob';
    this.fullPlane.visible = full;
    this.light.castShadow = full;
    this.blobPlane.visible = blob;
  }

  /** 毎フレーム呼ぶ。fullモード時のみシャドウマップを2フレームに1回更新する */
  update(): void {
    if (!this.fullPlane.visible) return;
    this.light.shadow.needsUpdate = this.frame % 2 === 0;
    this.frame += 1;
  }
}
