/**
 * 手に載せるメニュー(VRChat のクイックメニューのように、開いた手についてくる)。
 *
 * - コントローラ: B/Y ボタンを押した手の上に開く。同じ手でもう一度押すと閉じ、反対の手で押すとそちらへ移る
 * - 素手: 手のひらを顔に向けると、その手の上に開く。手のひらを返すと閉じる
 * - 選ぶのは反対の手のビーム(メニューを持っている手のビームは使わない。XrPanelController の exclude)
 *
 * パネルは手先寄りに、手と一緒に回るように置く(手首をひねるとパネルも傾く。VRChat と同じ)
 */
import * as THREE from 'three';
import type { SpatialPanel } from './spatialUI';

type Side = 'left' | 'right';

/** xr-standard の B/Y ボタン */
const MENU_BUTTON = 5;
/** 手のひらが顔を向いていると見なす向きの一致度(cos)。開くときと閉じるときで差を付けてばたつかせない */
const PALM_OPEN = 0.75;
const PALM_CLOSE = 0.45;
/** 手のひらの向きが続いたら開く・閉じるまでの時間(ms)。手を振ったときに一瞬開くのを防ぐ */
const PALM_OPEN_MS = 250;
const PALM_CLOSE_MS = 400;
/**
 * コントローラで持つときの、グリップ(握った手の中心)から見たパネルの下辺の位置(m)。
 * グリップの -Z が手先(コントローラの先)、+Y が手の甲の上側。手先へ出して、少し上に浮かせる
 */
const GRIP_OFFSET = new THREE.Vector3(0, 0.03, -0.08);
/**
 * コントローラで持つときのパネルの傾き。グリップの向きのままだと、パネルの表(+Z)が水平に手前を向くが、
 * 目は手より上にあるので、上へ70°起こして見上げる向きにする(30°・50°では手前に倒れて見えた。Quest のグリップは
 * 握りの傾きのぶん手前へ倒れているため)
 */
const GRIP_TILT = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (-70 * Math.PI) / 180);
/** 素手で持つときの、手のひらの中心から指先の方向・手のひらの前への出し方(m) */
const PALM_FORWARD = 0.09;
const PALM_OUT = 0.03;
/** 手の揺れを少しだけならす割合(1フレームあたり。1で手にぴったり) */
const FOLLOW = 0.6;

const _head = new THREE.Vector3();
const _hand = new THREE.Vector3();
const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _palm = new THREE.Vector3();
const _side = new THREE.Vector3();
const _matrix = new THREE.Matrix4();
const _quat = new THREE.Quaternion();
const _target = new THREE.Quaternion();

export class HandMenu {
  /** メニューを持っている手(閉じているときは null) */
  holder: Side | null = null;
  /** 開いたきっかけ。手のひらで開いたときだけ、手のひらを返すと閉じる */
  private openedBy: 'button' | 'palm' | null = null;
  private readonly buttonDown: Record<Side, boolean> = { left: false, right: false };
  /** 手のひらが顔を向いた・向かなくなった時刻 */
  private readonly palmSince: Record<Side, number | null> = { left: null, right: null };
  private palmAwaySince: number | null = null;
  private placed = false;

  constructor(private readonly panel: SpatialPanel) {}

  /** コントローラの手に開く(VRに入ったとき、置き場所を知らせるのに使う) */
  open(side: Side): void {
    this.holder = side;
    this.openedBy = 'button';
    this.placed = false;
    this.palmAwaySince = null;
  }

  close(): void {
    this.palmAwaySince = null;
    this.holder = null;
    this.openedBy = null;
    this.panel.hide();
  }

  /** 毎フレーム呼ぶ。ボタンと手のひらを見て開け閉めし、持っている手の上へパネルを動かす */
  update(frame: XRFrame, refSpace: XRReferenceSpace, session: XRSession): void {
    const viewer = frame.getViewerPose(refSpace);
    if (!viewer) return;
    const p = viewer.transform.position;
    _head.set(p.x, p.y, p.z);
    const now = performance.now();
    let anchor: THREE.Vector3 | null = null;
    // anchor が決まったら、パネルの向きは _target に入れる

    for (const source of session.inputSources) {
      const side = source.handedness;
      if (side !== 'left' && side !== 'right') continue;

      if (source.hand) {
        const palm = readPalm(frame, source.hand, side, refSpace);
        this.buttonDown[side] = false;
        if (!palm) {
          this.palmSince[side] = null;
          continue;
        }
        const facing = _a.copy(_head).sub(palm.center).normalize().dot(palm.normal);
        if (facing > PALM_OPEN) {
          this.palmSince[side] ??= now;
          if (this.holder === null && now - this.palmSince[side]! > PALM_OPEN_MS) {
            this.holder = side;
            this.openedBy = 'palm';
            this.placed = false;
          }
        } else {
          this.palmSince[side] = null;
        }
        if (this.holder === side) {
          if (this.openedBy === 'palm' && facing < PALM_CLOSE) {
            this.palmAwaySince ??= now;
            if (now - this.palmAwaySince > PALM_CLOSE_MS) {
              this.close();
              continue;
            }
          } else {
            this.palmAwaySince = null;
          }
          // 手のひらの前、指先寄りに出す。パネルの上は指先の方向、表は手のひらの向き
          // (手のひらと一緒に回るので、手首をひねるとパネルも傾く)
          anchor = _hand
            .copy(palm.center)
            .addScaledVector(palm.fingers, PALM_FORWARD)
            .addScaledVector(palm.normal, PALM_OUT);
          _side.crossVectors(palm.fingers, palm.normal).normalize();
          _b.crossVectors(palm.normal, _side);
          _matrix.makeBasis(_side, _b, palm.normal);
          _target.setFromRotationMatrix(_matrix);
        }
        continue;
      }

      this.palmSince[side] = null;
      const pressed = source.gamepad?.buttons[MENU_BUTTON]?.pressed ?? false;
      if (pressed && !this.buttonDown[side]) {
        if (this.holder === side) {
          this.close();
        } else {
          this.holder = side;
          this.openedBy = 'button';
          this.placed = false;
        }
      }
      this.buttonDown[side] = pressed;
      if (this.holder === side && source.gripSpace) {
        const pose = frame.getPose(source.gripSpace, refSpace);
        if (pose) {
          // グリップと一緒に回す(手首をひねるとパネルも傾く)
          const g = pose.transform.orientation;
          _target.set(g.x, g.y, g.z, g.w);
          const t = pose.transform.position;
          anchor = _hand.copy(GRIP_OFFSET).applyQuaternion(_target).add(_b.set(t.x, t.y, t.z));
          _target.multiply(GRIP_TILT);
        }
      }
    }

    if (this.holder === null) return;
    if (!anchor) {
      // 持っている手が見えない(追跡が切れた)ときは隠しておき、戻ったらまた出す
      this.panel.hide();
      this.placed = false;
      return;
    }
    const object = this.panel.object;
    if (this.placed) {
      object.position.lerp(anchor, FOLLOW);
      _quat.copy(object.quaternion).slerp(_target, FOLLOW);
    } else {
      object.position.copy(anchor);
      _quat.copy(_target);
    }
    this.panel.show(object.position, _quat);
    this.placed = true;
  }
}

/**
 * 手のひらの中心と、手のひらが向いている方向、指先の方向。
 * 手のひらの向きは、手首から人差し指・小指の付け根への向きの外積で求める(右手は index × pinky が手のひら側。左手は逆)。
 * 指先の方向は手首から中指の付け根へ
 */
function readPalm(
  frame: XRFrame,
  hand: XRHand,
  side: Side,
  refSpace: XRReferenceSpace,
): { center: THREE.Vector3; normal: THREE.Vector3; fingers: THREE.Vector3 } | null {
  const wristSpace = hand.get('wrist');
  const indexSpace = hand.get('index-finger-metacarpal');
  const pinkySpace = hand.get('pinky-finger-metacarpal');
  const middleSpace = hand.get('middle-finger-phalanx-proximal');
  if (!wristSpace || !indexSpace || !pinkySpace || !middleSpace || !frame.getJointPose) return null;
  const wrist = frame.getJointPose(wristSpace, refSpace);
  const index = frame.getJointPose(indexSpace, refSpace);
  const pinky = frame.getJointPose(pinkySpace, refSpace);
  const middle = frame.getJointPose(middleSpace, refSpace);
  if (!wrist || !index || !pinky || !middle) return null;
  const w = wrist.transform.position;
  const i = index.transform.position;
  const k = pinky.transform.position;
  const m = middle.transform.position;
  _a.set(i.x - w.x, i.y - w.y, i.z - w.z);
  _b.set(k.x - w.x, k.y - w.y, k.z - w.z);
  _palm.crossVectors(_a, _b).normalize();
  if (side === 'left') _palm.negate();
  return {
    center: new THREE.Vector3((w.x + m.x) / 2, (w.y + m.y) / 2, (w.z + m.z) / 2),
    normal: _palm.clone(),
    fingers: new THREE.Vector3(m.x - w.x, m.y - w.y, m.z - w.z).normalize(),
  };
}
