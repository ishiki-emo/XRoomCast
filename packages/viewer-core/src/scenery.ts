/**
 * ステージ装飾: 明るいパステル背景+やわらかい影+
 * パステルカラーのプリミティブをアバターの背景にふわふわ配置する。
 */
import * as THREE from 'three';

export interface Scenery {
  /** 経過秒を渡すと浮遊オブジェクトをアニメーションさせる */
  update(elapsedSeconds: number): void;
  /** ARモード: 装飾(床・プリミティブ・背景・フォグ)を隠してアバターだけにする */
  setARMode(on: boolean): void;
  /**
   * 装飾(床・プリミティブ)の表示。
   * 配信者がステージを設定したときは引っ込める(二重に飾らない)
   */
  setDecorationsVisible(visible: boolean): void;
  /**
   * 配信者が決める配色。空(背景とフォグ)と地面をそれぞれ指定できる。
   * `null` を渡した項目は既定値へ戻す。ARでは背景も地面も出ないので効かない
   */
  setTheme(theme: { sky?: string | null; ground?: string | null }): void;
}

/** 配信者が色を決めなかったときの既定 */
export const DEFAULT_SKY_COLOR = '#f3edff';
export const DEFAULT_GROUND_COLOR = '#fbf8ff';

const BACKGROUND = 0xf3edff; // ラベンダーがかった白(DEFAULT_SKY_COLOR と同じ)
const PASTELS = {
  pink: 0xffd1dc,
  mint: 0xc8f0de,
  lavender: 0xd8ccf5,
  babyBlue: 0xcfe6ff,
  lemon: 0xfff2c0,
  peach: 0xffe0cc,
} as const;

interface Floater {
  mesh: THREE.Mesh;
  baseY: number;
  amplitude: number;
  speed: number;
  phase: number;
  spin: number;
}

function pastelMaterial(color: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0 });
}

export function setupScenery(scene: THREE.Scene): Scenery {
  const background = new THREE.Color(BACKGROUND);
  const fog = new THREE.Fog(BACKGROUND, 9, 20);
  scene.background = background;
  scene.fog = fog;

  // 装飾(床・プリミティブ)はARモードでまとめて隠せるようグループに入れる。
  // ライトはARでもアバターに必要なのでグループ外
  const decorations = new THREE.Group();
  scene.add(decorations);
  /** AR中か / 配信者が装飾を出したいか。両方を満たすときだけ表示する */
  let arMode = false;
  let decorationsWanted = true;

  // ライティング: パステルに合わせて柔らかく明るく
  const hemisphere = new THREE.HemisphereLight(0xffffff, 0xe6d9ee, 1.1);
  scene.add(hemisphere);

  const sun = new THREE.DirectionalLight(0xfff6e8, 1.8);
  sun.position.set(2.5, 4.5, 3);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  sun.shadow.camera.left = -4;
  sun.shadow.camera.right = 4;
  sun.shadow.camera.top = 4;
  sun.shadow.camera.bottom = -4;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 12;
  sun.shadow.bias = -0.0002;
  scene.add(sun);

  // 地面: 白い円盤(縁はフォグに溶ける)
  const ground = new THREE.Mesh(
    new THREE.CircleGeometry(8, 48),
    new THREE.MeshStandardMaterial({ color: 0xfbf8ff, roughness: 1, metalness: 0 }),
  );
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  decorations.add(ground);

  // プリミティブの配置(アバターの後方・左右。カメラは+Z側から見る)
  const floaters: Floater[] = [];

  const place = (
    geometry: THREE.BufferGeometry,
    color: number,
    x: number,
    y: number,
    z: number,
    options: { float?: boolean; spin?: number; rotate?: [number, number, number] } = {},
  ): void => {
    const mesh = new THREE.Mesh(geometry, pastelMaterial(color));
    mesh.position.set(x, y, z);
    if (options.rotate) mesh.rotation.set(...options.rotate);
    mesh.castShadow = true;
    decorations.add(mesh);
    if (options.float) {
      floaters.push({
        mesh,
        baseY: y,
        amplitude: 0.12 + Math.abs(Math.sin(x * 7.3)) * 0.08, // 配置座標から決める疑似乱数
        speed: 0.5 + Math.abs(Math.sin(z * 3.1)) * 0.4,
        phase: x * 2.1 + z * 1.3,
        spin: options.spin ?? 0.15,
      });
    }
  };

  // 床に置くもの
  place(new THREE.SphereGeometry(0.42, 32, 24), PASTELS.pink, -1.9, 0.42, -1.6);
  place(new THREE.BoxGeometry(0.56, 0.56, 0.56), PASTELS.mint, 2.1, 0.28, -2.2, {
    rotate: [0, 0.5, 0],
  });
  place(new THREE.ConeGeometry(0.34, 0.85, 32), PASTELS.lemon, 1.6, 0.42, -1.2);
  place(new THREE.BoxGeometry(0.4, 0.4, 0.4), PASTELS.babyBlue, -2.8, 0.2, -3.0, {
    rotate: [0, -0.4, 0],
  });
  place(new THREE.SphereGeometry(0.24, 24, 18), PASTELS.peach, 2.9, 0.24, -3.4);

  // 浮かぶもの
  place(new THREE.TorusGeometry(0.36, 0.13, 20, 40), PASTELS.lavender, -2.3, 1.7, -3.2, {
    float: true,
    spin: 0.3,
    rotate: [0.6, 0, 0.3],
  });
  place(new THREE.IcosahedronGeometry(0.3, 0), PASTELS.babyBlue, 1.4, 2.1, -3.0, {
    float: true,
    spin: 0.4,
  });
  place(new THREE.SphereGeometry(0.16, 20, 16), PASTELS.peach, -0.9, 2.4, -3.6, { float: true });
  place(new THREE.CapsuleGeometry(0.16, 0.32, 8, 16), PASTELS.mint, 2.6, 1.5, -3.8, {
    float: true,
    spin: 0.25,
    rotate: [0, 0, 0.5],
  });
  place(new THREE.TorusGeometry(0.22, 0.08, 16, 32), PASTELS.pink, -2.7, 1.9, -3.9, {
    float: true,
    spin: -0.35,
    rotate: [1.1, 0.4, 0],
  });
  place(new THREE.OctahedronGeometry(0.2, 0), PASTELS.lemon, 0.4, 2.6, -4.2, {
    float: true,
    spin: 0.5,
  });

  return {
    update(elapsedSeconds: number): void {
      for (const f of floaters) {
        f.mesh.position.y = f.baseY + Math.sin(elapsedSeconds * f.speed + f.phase) * f.amplitude;
        f.mesh.rotation.y += f.spin * 0.016;
      }
    },
    setDecorationsVisible(visible: boolean): void {
      decorationsWanted = visible;
      decorations.visible = visible && !arMode;
    },
    setTheme(theme: { sky?: string | null; ground?: string | null }): void {
      if (theme.sky !== undefined) {
        background.set(theme.sky ?? DEFAULT_SKY_COLOR);
        // フォグも同じ色にしないと、遠景で地面の縁が浮いて見える
        fog.color.set(theme.sky ?? DEFAULT_SKY_COLOR);
      }
      if (theme.ground !== undefined) {
        (ground.material as THREE.MeshStandardMaterial).color.set(
          theme.ground ?? DEFAULT_GROUND_COLOR,
        );
      }
    },
    setARMode(on: boolean): void {
      arMode = on;
      decorations.visible = decorationsWanted && !on;
      scene.background = on ? null : background;
      scene.fog = on ? null : fog;
      // ARでは装飾床が消えるので太陽の影は不要。切ることで接地影プレーンへの
      // 二重影を防ぐ(太陽自体はアバターのライティングとして残す)
      sun.castShadow = !on;
    },
  };
}
