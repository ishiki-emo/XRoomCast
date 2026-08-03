/**
 * 1体のアバター(VRM本体・ポーズ適用・スケール追従・当たり判定)をまとめたユニット。
 * 差し替えはインスタンスの作り直しで行い、旧インスタンスは dispose() で破棄する。
 *
 * 配置フレーム(avatarRoot)はこのクラスの外にある。AR設置・つかみ移動・卓上
 * スケールはフレーム側の変換として行われ、PoseApplierがフレーム対応なので
 * アバターを差し替えてもIKや設置状態は壊れない。
 */
import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils, type VRM } from '@pixiv/three-vrm';
import { AvatarScaleAdapter } from './avatarScale';
import { PoseApplier } from './poseApplier';
import type { SampledFrame } from '@xroomcast/sync';

const loader = new GLTFLoader();
loader.register((parser) => new VRMLoaderPlugin(parser));

const _boundsInverse = new THREE.Matrix4();

export interface LoadProgress {
  loaded: number;
  total: number;
}

/**
 * 描画環境。渡すとロード完了前にシェーダのコンパイルとテクスチャのGPU
 * アップロードを済ませられる(切り替え時の一瞬のフリーズ対策)
 */
export interface PrecompileTarget {
  renderer: THREE.WebGLRenderer;
  camera: THREE.Camera;
  scene: THREE.Scene;
}

export interface AvatarLoadOptions {
  onProgress?: (progress: LoadProgress) => void;
  precompile?: PrecompileTarget;
}

/** GPU転送の待ち上限。これを超えたら表示を優先する(描画時に同期コンパイルされるだけ) */
const COMPILE_TIMEOUT_MS = 4000;
/** フレーム待ちの上限。XR中にフレームが来なくてもロードを止めないための保険 */
const YIELD_TIMEOUT_MS = 50;

/**
 * 次の描画フレームまで処理を譲る。
 * VRMの前処理はどれもメインスレッドを止めるため、工程の合間に挟んで
 * 「1回の長い停止」を「短い停止の連続」に崩す(その間に待機モーションも進む)。
 *
 * 注意: XRセッション中は window.requestAnimationFrame が発火しなくなるため、
 * セッションがあればそちらのフレームを使い、さらに時間でも保険をかける。
 * これを怠るとAR/MR中にロードが完了せず、アバターが差し替わらない
 */
function yieldFrame(renderer?: THREE.WebGLRenderer): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      resolve();
    };
    const session = renderer?.xr.getSession() ?? null;
    if (session) session.requestAnimationFrame(() => finish());
    else requestAnimationFrame(finish);
    setTimeout(finish, YIELD_TIMEOUT_MS);
  });
}

/**
 * レスト姿勢(Tポーズ)から測った基準位置。すべて配置フレームのローカル系。
 * 待機モーションはワイヤ形式(頭・両手の絶対位置)で作るため、身長や腕の長さが
 * モデルごとに違っても破綻しないよう、固定値ではなくここを起点にする
 */
export interface RestPose {
  head: THREE.Vector3;
  /** 腕を自然に下ろしたときの手の位置(肩から腕の長さぶん下ろした推定) */
  leftHand: THREE.Vector3;
  rightHand: THREE.Vector3;
  /** 身長の目安(頭の高さ)。揺れ幅のスケールに使う */
  height: number;
}

/** VRMのレスト姿勢を測って待機モーションの基準を作る */
function measureRestPose(vrm: VRM, frame: THREE.Object3D): RestPose {
  frame.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(frame.matrixWorld).invert();
  const bone = (name: Parameters<typeof vrm.humanoid.getNormalizedBoneNode>[0]) =>
    vrm.humanoid.getNormalizedBoneNode(name);
  const localOf = (node: THREE.Object3D | null, fallback: THREE.Vector3): THREE.Vector3 =>
    node ? node.getWorldPosition(new THREE.Vector3()).applyMatrix4(toLocal) : fallback.clone();

  const head = localOf(bone('head'), new THREE.Vector3(0, 1.35, 0));
  const height = head.y > 0.1 ? head.y : 1.35;

  const handFor = (side: 'left' | 'right'): THREE.Vector3 => {
    const sign = side === 'left' ? 1 : -1;
    const shoulder = localOf(
      bone(side === 'left' ? 'leftUpperArm' : 'rightUpperArm'),
      new THREE.Vector3(sign * height * 0.13, height * 0.78, 0),
    );
    const restHand = localOf(
      bone(side === 'left' ? 'leftHand' : 'rightHand'),
      new THREE.Vector3(sign * height * 0.42, height * 0.78, 0),
    );
    const armLength = Math.max(shoulder.distanceTo(restHand), height * 0.2);
    // 肩から真下へ下ろし、少しだけ体側(内向き)と前方へ寄せる
    return new THREE.Vector3(
      shoulder.x * 0.82,
      shoulder.y - armLength * 0.94,
      shoulder.z + height * 0.02,
    );
  };

  return { head, leftHand: handFor('left'), rightHand: handFor('right'), height };
}

/**
 * つかみ判定に使うバウンディングボックスを測る。
 *
 * Box3.setFromObject はブレンドシェイプ(モーフターゲット)の変位をすべて
 * 含めた範囲を返すため、表情モーフの大きいVRMでは箱が実体より極端に広がる
 * (特に前後方向)。ここでは現在の頂点位置だけを見て測る
 */
function measureBounds(root: THREE.Object3D): THREE.Box3 {
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.updateWorldMatrix(true, true);
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry?.getAttribute('position');
    if (!(position instanceof THREE.BufferAttribute)) return;
    meshBox.setFromBufferAttribute(position);
    meshBox.applyMatrix4(mesh.matrixWorld);
    box.union(meshBox);
  });
  // 頂点属性を読めるメッシュが1つも無かった場合の保険
  if (box.isEmpty()) box.setFromObject(root);
  return box;
}

/**
 * 1メッシュあたりのモーフ数の上限。
 *
 * モーフはテクスチャのレイヤー(MAX_ARRAY_TEXTURE_LAYERS)だけでなく、頂点シェーダの
 * uniform配列 morphTargetInfluences[N] も消費する。モバイルGPUの
 * MAX_VERTEX_UNIFORM_VECTORS は256程度しかないため、レイヤー数に余裕があっても
 * uniform側で先に破綻してメッシュごと描画されなくなる。
 * 表情が実際に使うモーフは多くても数十個なので、余裕を持った小さめの値にする。
 */
const MORPH_LIMIT = 64;

interface MorphBind {
  primitives?: THREE.Mesh[];
  index?: number;
}

/**
 * VRMの表情から参照されていないモーフターゲットを削除する。
 *
 * three.jsはモーフを「1個=1レイヤー」のDataArrayTextureへ展開するため、
 * モーフ数がGPUの MAX_ARRAY_TEXTURE_LAYERS (モバイルでは256程度)を超えると
 * テクスチャを作れず、そのメッシュだけ描画されなくなる。
 * 編集時の名残で数百個のシェイプキーを持つVRMは珍しくない一方、表情が実際に
 * 使うのは数十個なので、使われているものだけ残せば表示も表情も両立できる。
 *
 * 閾値を超えたメッシュだけを対象にする(正常なモデルには手を触れない)。
 */
export function pruneUnusedMorphs(vrm: VRM, maxMorphs: number): string[] {
  const manager = vrm.expressionManager;
  if (!manager) return [];

  // 表情が参照しているモーフを集める(three-vrmの内部表現に触るため防御的に扱う)
  const usedByMesh = new Map<THREE.Mesh, Set<number>>();
  const binds: MorphBind[] = [];
  for (const expression of manager.expressions) {
    const list = (expression as unknown as { _binds?: unknown[] })._binds;
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const bind = raw as MorphBind;
      if (!Array.isArray(bind.primitives) || typeof bind.index !== 'number') continue;
      binds.push(bind);
      for (const mesh of bind.primitives) {
        if (!usedByMesh.has(mesh)) usedByMesh.set(mesh, new Set());
        usedByMesh.get(mesh)!.add(bind.index);
      }
    }
  }
  if (binds.length === 0) return [];

  const notes: string[] = [];
  /** 旧index → 新index。bindの付け替えに使う */
  const remapByMesh = new Map<THREE.Mesh, Map<number, number>>();

  for (const [mesh, used] of usedByMesh) {
    const attributes = mesh.geometry?.morphAttributes;
    const positions = attributes?.position;
    if (!attributes || !positions || positions.length <= maxMorphs) continue;

    const keep = [...used].sort((a, b) => a - b);
    const remap = new Map<number, number>();
    keep.forEach((oldIndex, newIndex) => remap.set(oldIndex, newIndex));
    remapByMesh.set(mesh, remap);

    // position / normal / tangent など、あるものすべてを同じ順序で絞る
    const pruned: Record<string, THREE.BufferAttribute[]> = {};
    for (const [name, list] of Object.entries(attributes)) {
      pruned[name] = keep
        .map((oldIndex) => list[oldIndex])
        .filter((attribute): attribute is THREE.BufferAttribute => attribute !== undefined);
    }
    mesh.geometry.morphAttributes = pruned;
    mesh.morphTargetInfluences = keep.map(() => 0);

    if (mesh.morphTargetDictionary) {
      const dictionary: Record<string, number> = {};
      for (const [name, oldIndex] of Object.entries(mesh.morphTargetDictionary)) {
        const newIndex = remap.get(oldIndex);
        if (newIndex !== undefined) dictionary[name] = newIndex;
      }
      mesh.morphTargetDictionary = dictionary;
    }

    // 表情が使っているモーフは削れないので、それだけで上限を超える場合は
    // 削減してもまだ描画されない可能性がある(パーフェクトシンク対応VRM等)
    const warning = keep.length > maxMorphs ? ` ※上限${maxMorphs}を超えたまま` : '';
    notes.push(`${mesh.name || '(無名)'}: ${positions.length} → ${keep.length}${warning}`);
  }

  // 参照側のindexを新しい番号へ付け替える(readonly宣言だが実体は書き換え可能)
  for (const bind of binds) {
    const mesh = bind.primitives?.[0];
    if (!mesh) continue;
    const remap = remapByMesh.get(mesh);
    if (!remap) continue;
    const newIndex = remap.get(bind.index!);
    if (newIndex !== undefined) (bind as { index: number }).index = newIndex;
  }

  return notes;
}

function extractVrm(gltf: GLTF): VRM {
  const vrm = gltf.userData.vrm as VRM | undefined;
  if (!vrm) {
    throw new Error('VRM拡張を含まないファイルです(glTF/GLBとしては読み込めました)');
  }
  return vrm;
}

export class Avatar {
  private constructor(
    readonly vrm: VRM,
    /** つかみ時の可視化用バウンディングボックス(フレームローカルで計測済み) */
    readonly bounds: THREE.Box3,
    /** 待機モーションの基準になるレスト姿勢 */
    readonly restPose: RestPose,
    /** モーフを削減した場合の内訳(表示して気づけるようにする) */
    readonly morphNotes: string[],
    private readonly frame: THREE.Object3D,
    private readonly applier: PoseApplier,
    private readonly scaleAdapter: AvatarScaleAdapter,
  ) {}

  /**
   * VRMを読み込んでフレームに追加する。
   * 失敗時は例外を投げ、フレームには何も追加しない(呼び出し側は
   * 旧アバターを破棄せずに表示を維持できる)
   */
  static async load(
    source: string | ArrayBuffer,
    frame: THREE.Object3D,
    options: AvatarLoadOptions = {},
  ): Promise<Avatar> {
    const { onProgress, precompile } = options;
    const gltf =
      typeof source === 'string'
        ? await loader.loadAsync(source, (event) =>
            onProgress?.({ loaded: event.loaded, total: event.total }),
          )
        : await loader.parseAsync(source, '');

    const vrm = extractVrm(gltf);

    // 各工程の所要時間(ms)。どこで止まっているかを実機で追えるようにする
    const timings: Record<string, number> = {};
    const measure = async (name: string, work: () => unknown): Promise<void> => {
      const start = performance.now();
      await work();
      timings[name] = Math.round(performance.now() - start);
      // 工程ごとにフレームを譲り、「1回の長い停止」を短い停止の連続に崩す
      await yieldFrame(precompile?.renderer);
    };

    // GPU側の制限も見て、より厳しい方を採用する
    const gl = precompile?.renderer.getContext();
    const gpuLimit =
      gl instanceof WebGL2RenderingContext
        ? Math.min(
            (gl.getParameter(gl.MAX_ARRAY_TEXTURE_LAYERS) as number) || MORPH_LIMIT,
            // uniform配列ぶんは他のuniformと共有するので、4分の1までに抑える
            Math.floor(((gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) as number) || 256) / 4),
          )
        : MORPH_LIMIT;
    const maxMorphs = Math.min(gpuLimit, MORPH_LIMIT);

    let morphNotes: string[] = [];
    await measure('モーフ整理', () => {
      morphNotes = pruneUnusedMorphs(vrm, maxMorphs);
      if (morphNotes.length > 0) {
        console.warn(
          `[avatar] モーフが多すぎるメッシュ(上限${maxMorphs})があったため、` +
            `表情で使われていないモーフを削除しました: ${morphNotes.join(' / ')}`,
        );
      }
    });
    await measure('頂点整理', () => VRMUtils.removeUnnecessaryVertices(gltf.scene));
    await measure('スケルトン統合', () => VRMUtils.combineSkeletons(gltf.scene));
    await measure('向き補正', () => {
      // VRM 0.xは+Z向きで読み込まれるため、VRM 1.0(-Z向き)と向きを揃える
      VRMUtils.rotateVRM0(vrm);
      vrm.scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        /**
         * スキニングとブレンドシェイプによる変形はバウンディング球に反映されないため、
         * 視点が任意の位置に来るHMD(両眼を別々にレンダリングする)では、視界内の
         * メッシュがカリングで消えることがある。アバターは数メッシュなので
         * カリングを切っても描画コストへの影響は小さい
         */
        mesh.frustumCulled = false;
      });
    });

    // シェーダのコンパイルとテクスチャのGPUアップロードを、表示に入れる前に済ませる。
    // シーンに入れる前に行うのが要点で、入れてしまうと次の描画で同期的に走ってしまう
    if (precompile) {
      // compileAsync はXRセッション中に解決しないことがあるため時間で打ち切る。
      // 打ち切っても描画時に同期コンパイルされるだけで、表示が止まることはない
      await measure('GPU転送', () =>
        Promise.race([
          precompile.renderer.compileAsync(vrm.scene, precompile.camera, precompile.scene),
          new Promise<void>((resolve) => setTimeout(resolve, COMPILE_TIMEOUT_MS)),
        ]),
      );
    }
    console.debug('[avatar] ロード内訳(ms):', timings);

    frame.add(vrm.scene);

    const bounds = measureBounds(vrm.scene);
    frame.updateWorldMatrix(true, false);
    bounds.applyMatrix4(_boundsInverse.copy(frame.matrixWorld).invert());

    // レスト姿勢の計測はポーズを当てる前に行う(PoseApplierは姿勢を変えないが順序を明示)
    const restPose = measureRestPose(vrm, frame);

    return new Avatar(
      vrm,
      bounds,
      restPose,
      morphNotes,
      frame,
      new PoseApplier(vrm, frame),
      new AvatarScaleAdapter(vrm),
    );
  }

  /** VRM 0.x / 1.0 の表示用ラベル */
  get versionLabel(): string {
    return this.vrm.meta.metaVersion === '0' ? '0.x' : '1.0';
  }

  /**
   * 頭のワールド位置(空間オーディオの音源位置に使う)。
   * 頭ボーンが無いモデルではレスト姿勢の頭位置で代用する
   */
  getHeadWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    const head = this.vrm.humanoid.getNormalizedBoneNode('head');
    if (head) return head.getWorldPosition(target);
    return target.copy(this.restPose.head).applyMatrix4(this.frame.matrixWorld);
  }

  applyPose(frame: SampledFrame): void {
    this.applier.apply(frame);
  }

  resetPose(): void {
    this.applier.reset();
  }

  /** フレームの均一スケールに揺れもの・アウトラインを追従させる */
  applyScale(scale: number): void {
    this.scaleAdapter.apply(scale);
  }

  update(delta: number): void {
    this.vrm.update(delta);
  }

  /** 表示から外すだけ(GPUリソースはまだ保持)。破棄と切り離して即座に呼べる */
  detach(): void {
    this.frame.remove(this.vrm.scene);
  }

  /**
   * 表示から外してGPUリソースを解放する。
   * 解放も重い処理なので、差し替え時は detach() で先に見た目を切り替え、
   * これは次のフレームに回すとフリーズが目立ちにくい
   */
  dispose(): void {
    this.detach();
    VRMUtils.deepDispose(this.vrm.scene);
  }
}
