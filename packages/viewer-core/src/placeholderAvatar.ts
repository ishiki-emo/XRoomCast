/**
 * VRMのロード中に立てておく仮アバター。
 * パステル調のクリスタルが浮遊・回転するだけのプリミティブ構成で、
 * 外部ファイルもヒューマノイドボーンも要らない(モーションは適用されない)。
 *
 * 「アバターを差し替えた瞬間に視聴者ごとのダウンロードが始まる」ため、
 * 完了タイミングは視聴者ごとにばらつく。その待ち時間に何も表示されない
 * (=配信が止まったように見える)のを防ぐのが役割。
 */
import * as THREE from 'three';

const COLORS = {
  lavender: 0xd8ccf5,
  babyBlue: 0xcfe6ff,
  pink: 0xffd1dc,
} as const;

interface Part {
  mesh: THREE.Mesh;
  baseY: number;
  amplitude: number;
  speed: number;
  phase: number;
  spin: number;
  /** 中心からの水平距離(0なら公転しない) */
  orbitRadius: number;
  orbitSpeed: number;
  orbitPhase: number;
}

function crystalMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 0.35,
    roughness: 0.25,
    metalness: 0.05,
    transparent: true,
    opacity: 0.85,
  });
}

export class PlaceholderAvatar {
  private readonly group = new THREE.Group();
  private readonly parts: Part[] = [];

  constructor(frame: THREE.Object3D) {
    const add = (
      geometry: THREE.BufferGeometry,
      color: number,
      y: number,
      options: Partial<Omit<Part, 'mesh' | 'baseY'>> = {},
    ): void => {
      const mesh = new THREE.Mesh(geometry, crystalMaterial(color));
      mesh.castShadow = true;
      mesh.position.y = y;
      this.group.add(mesh);
      this.parts.push({
        mesh,
        baseY: y,
        amplitude: options.amplitude ?? 0.05,
        speed: options.speed ?? 0.8,
        phase: options.phase ?? 0,
        spin: options.spin ?? 0.6,
        orbitRadius: options.orbitRadius ?? 0,
        orbitSpeed: options.orbitSpeed ?? 0.6,
        orbitPhase: options.orbitPhase ?? 0,
      });
    };

    // 等身大の人がひとり立つ空間に、頭・胸・腰と縦に連なるシルエットで置く。
    // 単体で大きく出すと存在感が過剰になり、散らすと人型に見えなくなるため、
    // 「人の形に沿った光の連なり」にまとめている。
    // avatarRootの子なので、卓上ミニサイズ(1/10)にすれば一緒に縮む
    add(new THREE.OctahedronGeometry(0.13, 0), COLORS.lavender, 1.4, {
      amplitude: 0.04,
      speed: 0.7,
      spin: 0.5,
    });
    add(new THREE.IcosahedronGeometry(0.1, 0), COLORS.babyBlue, 1.12, {
      amplitude: 0.03,
      speed: 0.9,
      phase: 0.8,
      spin: 0.4,
    });
    add(new THREE.OctahedronGeometry(0.075, 0), COLORS.lavender, 0.86, {
      amplitude: 0.025,
      speed: 1.1,
      phase: 1.9,
      spin: -0.35,
    });
    // 体の周りを回る小さな粒(左右に1つずつ、手の高さあたり)
    add(new THREE.IcosahedronGeometry(0.045, 0), COLORS.pink, 1.2, {
      orbitRadius: 0.26,
      orbitSpeed: 0.55,
      orbitPhase: 0,
      speed: 1.3,
      spin: 0.9,
    });
    add(new THREE.IcosahedronGeometry(0.038, 0), COLORS.babyBlue, 0.98, {
      orbitRadius: 0.29,
      orbitSpeed: -0.45,
      orbitPhase: Math.PI,
      speed: 1.05,
      phase: 3.1,
      spin: -0.8,
    });

    frame.add(this.group);
  }

  get visible(): boolean {
    return this.group.visible;
  }

  setVisible(on: boolean): void {
    this.group.visible = on;
  }

  /** 毎フレーム経過秒を渡す(非表示のときは何もしない) */
  update(elapsedSeconds: number): void {
    if (!this.group.visible) return;
    for (const part of this.parts) {
      part.mesh.position.y =
        part.baseY + Math.sin(elapsedSeconds * part.speed + part.phase) * part.amplitude;
      if (part.orbitRadius > 0) {
        const angle = elapsedSeconds * part.orbitSpeed + part.orbitPhase;
        part.mesh.position.x = Math.cos(angle) * part.orbitRadius;
        part.mesh.position.z = Math.sin(angle) * part.orbitRadius;
      }
      part.mesh.rotation.y += part.spin * 0.016;
      part.mesh.rotation.x += part.spin * 0.008;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const part of this.parts) {
      part.mesh.geometry.dispose();
      (part.mesh.material as THREE.Material).dispose();
    }
  }
}
