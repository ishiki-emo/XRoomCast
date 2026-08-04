/**
 * AR中に出すステージ(足元の台と、周囲に浮かぶ装飾)。
 *
 * **アバターのフレーム(avatarRoot)にぶら下げる前提**で作ってある。
 * scene直下に置くと、ARでアバターを設置・移動しても付いてこない。
 * ぶら下げておくと、
 * - 床をタップして置いた場所にステージごと乗る
 * - ミニ 1/10 にするとステージごと卓上サイズのジオラマになる
 * という具合に、既存の配置・伸縮の仕組みへそのまま乗る。
 *
 * PC表示の装飾(scenery.ts)とは別物。あちらは8m規模でARには大きすぎるため、
 * ここはアバターの周囲1m強に収まる控えめな構成にしている。
 */
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

/** scenery.ts と同じ系統の淡い色 */
const COLORS = {
  pink: 0xffd6e8,
  mint: 0xd6f5e3,
  lemon: 0xfff3c4,
  babyBlue: 0xd6ecff,
  lavender: 0xe6dcff,
} as const;

/** 設置位置を示す床のリング。**厚みを持たせると足が埋まる**ので薄く平らに置く */
const RING_RADIUS = 0.72;

/**
 * 顔の高さ帯。ここを横切ると表情が隠れるので、周回するものは
 * この上下どちらかに逃がす
 */
const FACE_BAND: readonly [number, number] = [1.15, 1.75];

interface Floater {
  mesh: THREE.Mesh;
  /** 周回半径(0なら定位置で上下するだけ) */
  orbitRadius: number;
  /** 周回の速さ(ラジアン/秒)。負なら逆回り */
  orbitSpeed: number;
  /** 定位置のもの用 */
  baseX: number;
  baseZ: number;
  baseY: number;
  amplitude: number;
  bobSpeed: number;
  phase: number;
  spin: THREE.Vector3;
}

/**
 * ステージの中身。
 * - none    : 何も出さない
 * - builtin : 組み込みの浮遊装飾
 * - model   : 配信者がアップロードしたglTF/GLB
 */
export type StageSource = 'none' | 'builtin' | 'model';

export interface Stage {
  /** avatarRoot へ add する対象 */
  readonly object: THREE.Object3D;
  setVisible(visible: boolean): void;
  readonly visible: boolean;
  /** 組み込み装飾とモデルの切り替え */
  setSource(source: StageSource): void;
  /**
   * モデルの読み込み。**アバターの足元が原点・正面が -Z** という約束で
   * 作られたものを、そのままアバターのフレームへ置く。
   * 同じURLなら読み直さない(押し出しが重複しても無駄が出ない)
   */
  loadModel(url: string | null): Promise<void>;
  update(elapsedSeconds: number): void;
  dispose(): void;
}

function softMaterial(color: number, opacity = 1): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.85,
    metalness: 0,
    transparent: opacity < 1,
    opacity,
  });
}

export function createStage(): Stage {
  const root = new THREE.Group();
  root.name = 'stage';
  root.visible = false;

  /** 組み込み装飾。モデルを使うときは丸ごと隠す */
  const builtin = new THREE.Group();
  root.add(builtin);
  /** 読み込んだモデルの置き場 */
  const modelRoot = new THREE.Group();
  root.add(modelRoot);

  const disposables: (THREE.BufferGeometry | THREE.Material)[] = [];
  const floaters: Floater[] = [];
  let source: StageSource = 'builtin';
  let loadedUrl: string | null = null;
  /** 読み込み中のURL(古い応答で新しいモデルを上書きしないため) */
  let loadingUrl: string | null = null;

  const add = (mesh: THREE.Mesh): THREE.Mesh => {
    // ARでは接地影を別に描いているので、ステージ側で影を作ると二重になる
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    disposables.push(mesh.geometry, mesh.material as THREE.Material);
    builtin.add(mesh);
    return mesh;
  };

  /**
   * 足元のリング。**厚みのある台にすると足が埋まる**ので、床に貼るだけにする。
   * 設置した位置が分かる程度の主張に留める
   */
  const ring = add(
    new THREE.Mesh(
      new THREE.RingGeometry(RING_RADIUS - 0.02, RING_RADIUS, 64),
      softMaterial(COLORS.lavender, 0.7),
    ),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.006; // 現実の床とのZファイティングを避ける最小限の浮き
  (ring.material as THREE.MeshStandardMaterial).side = THREE.DoubleSide;

  /**
   * 浮遊する装飾。**大小の差と動きの分かりやすさ**を優先している。
   * ARでは視聴者が自由に回り込めるので、周回させると立体感が伝わりやすい。
   * ただし顔の高さ帯を横切ると表情が隠れるため、その上下へ逃がす
   */
  const float = (options: {
    geometry: THREE.BufferGeometry;
    color: number;
    /** 周回半径。0なら定位置 */
    orbit?: number;
    /** 周回の速さ。負で逆回り */
    orbitSpeed?: number;
    y: number;
    /** 定位置のときの座標 */
    at?: [number, number];
    phase?: number;
    amplitude?: number;
    bobSpeed?: number;
    spin?: [number, number, number];
  }): void => {
    const mesh = add(new THREE.Mesh(options.geometry, softMaterial(options.color, 0.92)));
    const [x, z] = options.at ?? [0, 0];
    floaters.push({
      mesh,
      orbitRadius: options.orbit ?? 0,
      orbitSpeed: options.orbitSpeed ?? 0,
      baseX: x,
      baseZ: z,
      baseY: options.y,
      amplitude: options.amplitude ?? 0.06,
      bobSpeed: options.bobSpeed ?? 0.8,
      phase: options.phase ?? 0,
      spin: new THREE.Vector3(...(options.spin ?? [0, 0.5, 0])),
    });
  };

  // 大: 頭上をゆっくり回る。全体の視線誘導になる
  float({
    geometry: new THREE.IcosahedronGeometry(0.26, 0),
    color: COLORS.pink,
    orbit: 1.15,
    orbitSpeed: 0.22,
    y: FACE_BAND[1] + 0.35,
    phase: 0,
    amplitude: 0.1,
    bobSpeed: 0.5,
    spin: [0.15, 0.3, 0],
  });
  // 中: 足元まわりを逆回り(大と反対に回すと動きが読み取りやすい)
  float({
    geometry: new THREE.BoxGeometry(0.15, 0.15, 0.15),
    color: COLORS.mint,
    orbit: 0.95,
    orbitSpeed: -0.35,
    y: 0.42,
    phase: 1.2,
    amplitude: 0.05,
    bobSpeed: 0.9,
    spin: [0.4, 0.6, 0.2],
  });
  float({
    geometry: new THREE.ConeGeometry(0.1, 0.24, 24),
    color: COLORS.lemon,
    orbit: 1.0,
    orbitSpeed: -0.35,
    y: 0.7,
    phase: 1.2 + Math.PI,
    amplitude: 0.07,
    bobSpeed: 0.7,
    spin: [0, 0.8, 0.3],
  });
  // 小: 定位置で速く回る。大きいものとの対比を出す
  float({
    geometry: new THREE.TetrahedronGeometry(0.05),
    color: COLORS.babyBlue,
    at: [-0.78, -0.55],
    y: 1.0,
    phase: 0.6,
    amplitude: 0.09,
    bobSpeed: 1.5,
    spin: [0.9, 1.2, 0],
  });
  float({
    geometry: new THREE.OctahedronGeometry(0.045),
    color: COLORS.lavender,
    at: [0.82, -0.5],
    y: 0.85,
    phase: 2.4,
    amplitude: 0.11,
    bobSpeed: 1.8,
    spin: [1.1, 0.7, 0.4],
  });
  float({
    geometry: new THREE.SphereGeometry(0.035, 20, 16),
    color: COLORS.pink,
    at: [-0.35, 0.85],
    y: 1.95,
    phase: 4.1,
    amplitude: 0.13,
    bobSpeed: 2.1,
    spin: [0, 1.5, 0],
  });

  const applySource = (): void => {
    builtin.visible = source === 'builtin';
    modelRoot.visible = source === 'model';
  };
  applySource();

  /** 読み込んだモデルを捨てる(差し替えのたびに積み上がらないように) */
  const clearModel = (): void => {
    modelRoot.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const material = mesh.material;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material.dispose();
    });
    modelRoot.clear();
    loadedUrl = null;
  };

  return {
    object: root,
    get visible(): boolean {
      return root.visible;
    },
    setVisible(visible: boolean): void {
      root.visible = visible;
    },
    setSource(next: StageSource): void {
      source = next;
      applySource();
    },
    async loadModel(url: string | null): Promise<void> {
      if (url === loadedUrl && url !== null) return;
      if (!url) {
        clearModel();
        return;
      }
      loadingUrl = url;
      const gltf = await new GLTFLoader().loadAsync(url);
      // 読み込み中に別のモデルへ切り替わっていたら捨てる
      if (loadingUrl !== url) return;
      clearModel();
      gltf.scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        // 接地影と二重にならないよう、ステージ側は影を落とさない
        mesh.castShadow = false;
        mesh.receiveShadow = true;
      });
      modelRoot.add(gltf.scene);
      loadedUrl = url;
    },
    update(elapsedSeconds: number): void {
      if (!root.visible || source !== 'builtin') return;
      for (const f of floaters) {
        const bob = Math.sin(elapsedSeconds * f.bobSpeed + f.phase) * f.amplitude;
        if (f.orbitRadius > 0) {
          const angle = f.phase + elapsedSeconds * f.orbitSpeed;
          f.mesh.position.set(
            Math.cos(angle) * f.orbitRadius,
            f.baseY + bob,
            Math.sin(angle) * f.orbitRadius,
          );
        } else {
          f.mesh.position.set(f.baseX, f.baseY + bob, f.baseZ);
        }
        // 軸ごとに速さを変えると、単純な回転より動きが分かりやすい
        f.mesh.rotation.x += f.spin.x * 0.016;
        f.mesh.rotation.y += f.spin.y * 0.016;
        f.mesh.rotation.z += f.spin.z * 0.016;
      }
    },
    dispose(): void {
      for (const item of disposables) item.dispose();
      root.clear();
    },
  };
}
