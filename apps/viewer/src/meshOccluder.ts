/**
 * 部屋メッシュのオクルージョン(WebXR Mesh Detection)。Quest のスペースセットアップで作られた
 * 部屋や家具のメッシュを、色を描かず深度だけ書く遮り物にして、その裏のアバターを隠す。
 *
 * 平面オクルーダー(ar.ts の planeOccluders)は壁や天板しか持てないが、メッシュならソファや棚の
 * 形のまま隠せる。深度センサーより輪郭がくっきりして、遅れも無い(動かない物に限る)。
 *
 * - **水平な面は使わない**。床とアバターの足は同じ高さにあり、床の三角形で足がちらつく・欠ける。
 *   卓上モードで机に立たせたときも同じ。水平な面の遮りは平面オクルーダー(床以外の天板)に任せる。
 *   メッシュの面の向き(巻き順)は仕様で決まっていないので、上向き・下向きのどちらも外す
 * - 裏表も決まっていないので両面で描く
 * - スキャン中は形が更新され続けるので、作り直しは0.5秒に1回までに間引く(平面と同じ)
 */
import * as THREE from 'three';

/** 面の法線のY成分がこれ以上なら水平な面とみなして外す(約45度より水平) */
const HORIZONTAL_NORMAL_Y = 0.7;
/** 作り直しの最短間隔(ミリ秒) */
const REBUILD_INTERVAL_MS = 500;

interface Entry {
  mesh: THREE.Mesh;
  lastChanged: number;
  rebuiltAt: number;
}

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _c = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();

export class MeshOccluder {
  private readonly entries = new Map<XRMesh, Entry>();
  private readonly material = new THREE.MeshBasicMaterial({
    colorWrite: false, // 深度のみ書き込む
    side: THREE.DoubleSide,
  });
  /** 診断の行。初めてメッシュが取れたときに埋まる */
  private summary: string | null = null;
  private summarized = false;

  constructor(private readonly scene: THREE.Scene) {}

  /** 毎フレーム呼ぶ(描画の前) */
  update(frame: XRFrame, refSpace: XRReferenceSpace | null): void {
    const detected = frame.detectedMeshes;
    if (!detected || !refSpace) return;

    // 消えたメッシュの遮り物を破棄
    for (const [xrMesh, entry] of this.entries) {
      if (!detected.has(xrMesh)) {
        this.dispose(entry.mesh);
        this.entries.delete(xrMesh);
      }
    }

    const now = performance.now();
    for (const xrMesh of detected) {
      const pose = frame.getPose(xrMesh.meshSpace, refSpace);
      let entry = this.entries.get(xrMesh);
      if (!pose) {
        if (entry) entry.mesh.visible = false;
        continue;
      }
      const needsRebuild =
        !entry ||
        (entry.lastChanged < xrMesh.lastChangedTime && now - entry.rebuiltAt > REBUILD_INTERVAL_MS);
      if (needsRebuild) {
        if (entry) this.dispose(entry.mesh);
        // 水平かどうかは部屋の上下で決めるので、メッシュの向きを渡す(向きは動かない前提)
        const o = pose.transform.orientation;
        _q.set(o.x, o.y, o.z, o.w);
        const mesh = this.build(xrMesh, _q);
        entry = { mesh, lastChanged: xrMesh.lastChangedTime, rebuiltAt: now };
        this.entries.set(xrMesh, entry);
        this.scene.add(mesh);
      }
      entry!.mesh.matrix.fromArray(pose.transform.matrix);
      entry!.mesh.visible = true;
    }

    if (!this.summarized && this.entries.size > 0) {
      this.summarized = true;
      let triangles = 0;
      const labels = new Set<string>();
      for (const [xrMesh, entry] of this.entries) {
        triangles += (entry.mesh.geometry.index?.count ?? 0) / 3;
        if (xrMesh.semanticLabel) labels.add(xrMesh.semanticLabel);
      }
      this.summary = `メッシュ: ${this.entries.size}個 / 三角形${triangles} ${[...labels].join(',')}`;
      console.log('[ar mesh]', this.summary);
    }
  }

  /** 診断の行を一度だけ受け取る(まだメッシュが来ていなければ null) */
  takeSummary(): string | null {
    const summary = this.summary;
    this.summary = null;
    return summary;
  }

  clear(): void {
    for (const entry of this.entries.values()) this.dispose(entry.mesh);
    this.entries.clear();
    this.summary = null;
    this.summarized = false;
  }

  /** メッシュの頂点と三角形から遮り物を作る。水平な面の三角形は外す */
  private build(xrMesh: XRMesh, orientation: THREE.Quaternion): THREE.Mesh {
    const v = xrMesh.vertices;
    const source = xrMesh.indices;
    const kept: number[] = [];
    for (let i = 0; i + 2 < source.length; i += 3) {
      const ia = source[i]!;
      const ib = source[i + 1]!;
      const ic = source[i + 2]!;
      _a.set(v[ia * 3]!, v[ia * 3 + 1]!, v[ia * 3 + 2]!);
      _b.set(v[ib * 3]!, v[ib * 3 + 1]!, v[ib * 3 + 2]!);
      _c.set(v[ic * 3]!, v[ic * 3 + 1]!, v[ic * 3 + 2]!);
      _n.crossVectors(_b.sub(_a), _c.sub(_a));
      if (_n.lengthSq() < 1e-12) continue; // つぶれた三角形
      _n.normalize().applyQuaternion(orientation);
      if (Math.abs(_n.y) >= HORIZONTAL_NORMAL_Y) continue;
      kept.push(ia, ib, ic);
    }
    const geometry = new THREE.BufferGeometry();
    // 頂点は端末の配列を写して持つ(端末側の配列は更新で差し替わるため)
    geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(v), 3));
    geometry.setIndex(kept);
    const mesh = new THREE.Mesh(geometry, this.material);
    mesh.renderOrder = -1; // アバターより先に描いて深度を確定させる(平面オクルーダーと同じ)
    mesh.matrixAutoUpdate = false;
    mesh.frustumCulled = false; // 位置は matrix で直接与えるので、境界球の計算は省く
    mesh.visible = false;
    return mesh;
  }

  private dispose(mesh: THREE.Mesh): void {
    this.scene.remove(mesh);
    mesh.geometry.dispose();
  }
}
