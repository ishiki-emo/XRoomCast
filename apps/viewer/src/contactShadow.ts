/**
 * アバターに追従する接地影(AR用)。
 * ARでは装飾の床が消えるため実在感が薄い。そこで avatarRoot の足元に
 * 「影のときだけ濃くなる透明な板(ShadowMaterial)」を敷き、真上やや斜めの
 * 影専用ライト(強度0でも影は落ちる)でアバターの影だけを落とす。
 *
 * すべて avatarRoot の子にするので、設置・つかみ移動・卓上スケールに追従する。
 */
import * as THREE from 'three';

export class ContactShadow {
  private readonly light: THREE.DirectionalLight;
  private readonly target = new THREE.Object3D();
  private readonly plane: THREE.Mesh;

  constructor(avatarRoot: THREE.Object3D) {
    // 影専用ライト: 強度0でも castShadow=true なら ShadowMaterial に影を落とす。
    // ほぼ真上に置くことで「接地コンタクトシャドウ」らしい足元の影になる
    this.light = new THREE.DirectionalLight(0xffffff, 0);
    this.light.position.set(0.4, 3, 0.7);
    this.light.castShadow = true;
    // 足元のぼかし影には512で十分(1024比でシャドウマップ描画を1/4に)
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
    // シャドウマップは自前で間引き更新する(足はIK接地でほぼ動かないので
    // 毎フレーム描き直す必要がない)
    this.light.shadow.autoUpdate = false;

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(4, 4).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    this.plane.position.y = 0.001; // 実床(y=0)との z-fight 回避
    this.plane.receiveShadow = true;

    avatarRoot.add(this.target, this.light, this.plane);
    this.setEnabled(false);
  }

  setEnabled(on: boolean): void {
    this.plane.visible = on;
    this.light.castShadow = on;
    this.frame = 0;
  }

  private frame = 0;

  /** 毎フレーム呼ぶ。有効時はシャドウマップを2フレームに1回だけ更新する */
  update(): void {
    if (!this.plane.visible) return;
    this.light.shadow.needsUpdate = this.frame % 2 === 0;
    this.frame += 1;
  }
}
