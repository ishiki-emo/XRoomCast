/**
 * 他の視聴者の「気配」表示(Tier 1)。
 *
 * 視聴者はそれぞれ別の物理空間にいるため、共通の座標系は存在しない。
 * そこで位置は「アバター(配置フレーム)から見た相対座標」で共有する。
 * 各自が自分の空間で設置したアバターを基準に配置するので、結果として
 * みんながアバターを囲んでいるように見える。フレームの子なので、AR設置・
 * 卓上ミニサイズ・つかみ移動にもそのまま追従する。
 *
 * 表示は端末に合わせて変える(HMDならゴーグルとコントローラ、スマホなら板)。
 * 顔や名前は出さず、あくまで「そこに誰かが居る」ことだけを伝える。
 */
import * as THREE from 'three';

export type PeerDevice = 'hmd' | 'phone' | 'desktop';

/** 位置と向き(x,y,z, qx,qy,qz,qw)。送信量を抑えるため配列で持つ */
export type PeerNode = number[];

export interface PeerState {
  device?: PeerDevice;
  /** 頭(またはカメラ) */
  h?: PeerNode;
  /** 左手・右手(HMDのみ) */
  l?: PeerNode;
  r?: PeerNode;
}

/** 更新が途絶えた視聴者を消すまでの時間 */
const STALE_MS = 6000;
/** 位置の追従の速さ(1に近いほど機敏。10Hz受信を滑らかに見せる) */
const SMOOTH = 0.25;

/** IDから決まる色。同じ人は常に同じ色になる */
function colorFor(id: string): THREE.Color {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return new THREE.Color().setHSL((hash % 360) / 360, 0.55, 0.62);
}

function bodyMaterial(color: THREE.Color): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.45,
    metalness: 0.1,
    transparent: true,
    opacity: 0.9,
  });
}

/** 画面・レンズ面。暗くして「こちらを見ている面」が分かるようにする */
function screenMaterial(): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color: 0x1a1a22, roughness: 0.3, metalness: 0.2 });
}

/** HMD: ゴーグル本体(横長の箱)+ 前面の暗いレンズ面 */
function buildHmd(color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.19, 0.09, 0.1), bodyMaterial(color));
  const lens = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.065), screenMaterial());
  lens.position.z = -0.051; // 視線方向(-Z)が前
  lens.rotation.y = Math.PI;
  group.add(body, lens);
  return group;
}

/** コントローラ: 握り部分の小さなカプセル */
function buildController(color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const grip = new THREE.Mesh(new THREE.CapsuleGeometry(0.022, 0.07, 6, 12), bodyMaterial(color));
  grip.rotation.x = Math.PI / 2.4; // 自然な握りの角度
  const ring = new THREE.Mesh(
    new THREE.TorusGeometry(0.035, 0.008, 8, 20),
    bodyMaterial(color),
  );
  ring.position.set(0, 0.03, -0.02);
  ring.rotation.x = Math.PI / 2;
  group.add(grip, ring);
  return group;
}

/** スマホ: 縦長の薄い板。画面側が視聴者の向き */
function buildPhone(color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.15, 0.009), bodyMaterial(color));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.066, 0.135), screenMaterial());
  screen.position.z = -0.005;
  screen.rotation.y = Math.PI;
  group.add(body, screen);
  return group;
}

/** PC: 小さなモニタ(画面+スタンド)。動かないので控えめな大きさ */
function buildDesktop(color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.17, 0.11, 0.012), bodyMaterial(color));
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.155, 0.095), screenMaterial());
  screen.position.z = -0.007;
  screen.rotation.y = Math.PI;
  const stand = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.035, 0.01), bodyMaterial(color));
  stand.position.y = -0.072;
  group.add(body, screen, stand);
  return group;
}

function buildHead(device: PeerDevice, color: THREE.Color): THREE.Group {
  if (device === 'hmd') return buildHmd(color);
  if (device === 'phone') return buildPhone(color);
  return buildDesktop(color);
}

/** 目標値へ滑らかに寄せるノード */
class SmoothNode {
  readonly object = new THREE.Group();
  private readonly targetPosition = new THREE.Vector3();
  private readonly targetQuaternion = new THREE.Quaternion();
  private started = false;

  setTarget(node: PeerNode): void {
    if (node.length < 7) return;
    this.targetPosition.set(node[0]!, node[1]!, node[2]!);
    this.targetQuaternion.set(node[3]!, node[4]!, node[5]!, node[6]!);
    if (!this.started) {
      // 最初の1回は補間せずに合わせる(遠くから飛んでくるのを防ぐ)
      this.started = true;
      this.object.position.copy(this.targetPosition);
      this.object.quaternion.copy(this.targetQuaternion);
    }
    this.object.visible = true;
  }

  update(): void {
    if (!this.started) return;
    this.object.position.lerp(this.targetPosition, SMOOTH);
    this.object.quaternion.slerp(this.targetQuaternion, SMOOTH);
  }
}

class Peer {
  readonly group = new THREE.Group();
  private readonly head = new SmoothNode();
  private readonly hands: SmoothNode[] = [];
  private device: PeerDevice;
  lastSeen = 0;

  constructor(
    readonly id: string,
    device: PeerDevice,
  ) {
    this.device = device;
    const color = colorFor(id);
    this.head.object.add(buildHead(device, color));
    this.group.add(this.head.object);

    for (let i = 0; i < 2; i += 1) {
      const hand = new SmoothNode();
      hand.object.add(buildController(color));
      hand.object.visible = false;
      this.hands.push(hand);
      this.group.add(hand.object);
    }
  }

  apply(state: PeerState, now: number): void {
    this.lastSeen = now;
    // 端末が変わった(PCで開いていた人がHMDに入った等)ら見た目を作り直す
    if (state.device && state.device !== this.device) {
      this.device = state.device;
      const color = colorFor(this.id);
      this.head.object.clear();
      this.head.object.add(buildHead(this.device, color));
    }
    if (state.h) this.head.setTarget(state.h);
    if (state.l) this.hands[0]!.setTarget(state.l);
    else this.hands[0]!.object.visible = false;
    if (state.r) this.hands[1]!.setTarget(state.r);
    else this.hands[1]!.object.visible = false;
  }

  update(): void {
    this.head.update();
    for (const hand of this.hands) hand.update();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material.dispose();
    });
  }
}

export class PeerPresence {
  private readonly peers = new Map<string, Peer>();
  private enabled = true;

  /** @param frame アバターの配置フレーム。位置はこのローカル座標で受け取る */
  constructor(private readonly frame: THREE.Object3D) {}

  get count(): number {
    return this.peers.size;
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (!on) this.clear();
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  apply(id: string, state: PeerState): void {
    if (!this.enabled) return;
    let peer = this.peers.get(id);
    if (!peer) {
      peer = new Peer(id, state.device ?? 'desktop');
      this.peers.set(id, peer);
      this.frame.add(peer.group);
    }
    peer.apply(state, performance.now());
  }

  remove(id: string): void {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.dispose();
    this.peers.delete(id);
  }

  clear(): void {
    for (const peer of this.peers.values()) peer.dispose();
    this.peers.clear();
  }

  /** 毎フレーム呼ぶ。補間の更新と、途絶えた視聴者の掃除 */
  update(): void {
    const now = performance.now();
    for (const [id, peer] of this.peers) {
      if (now - peer.lastSeen > STALE_MS) {
        peer.dispose();
        this.peers.delete(id);
        continue;
      }
      peer.update();
    }
  }
}
