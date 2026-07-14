/**
 * VMCのボーンローカル姿勢からFK(前向き運動学)でHead/両手首の
 * アバタールート空間での姿勢を合成する。
 * VMCの /VMC/Ext/Bone/Pos は「親ボーンに対するローカル姿勢」で届くため、
 * Hipsから対象ボーンまで順に合成する必要がある(チェーン上にないボーンは無視)。
 * 座標系はここではUnity系のまま。Three.js系への変換は送出直前に行う。
 */
import type { FingerCurls, Quat, Vec3 } from '@vrmsync/protocol';
import { addVec3, IDENTITY_QUAT, quatAngle, quatMul, rotateVec3, ZERO_VEC3 } from './math.js';

interface BonePose {
  pos: Vec3;
  rot: Quat;
}

/** Unity HumanBodyBones名。UpperChest/Shoulderは無いモデルもあるため合成時にスキップ可 */
const HEAD_CHAIN = ['Hips', 'Spine', 'Chest', 'UpperChest', 'Neck', 'Head'];
const HAND_CHAIN = (side: 'Left' | 'Right') => [
  'Hips',
  'Spine',
  'Chest',
  'UpperChest',
  `${side}Shoulder`,
  `${side}UpperArm`,
  `${side}LowerArm`,
  `${side}Hand`,
];

const FINGERS = ['Thumb', 'Index', 'Middle', 'Ring', 'Little'] as const;
const FINGER_SEGMENTS = ['Proximal', 'Intermediate', 'Distal'] as const;
/** 全関節の合計屈曲角がこの値でカール1.0とみなす(ビューア側の展開角に合わせる) */
const FULL_CURL_ANGLE = 3.6;
const THUMB_FULL_CURL_ANGLE = 1.6;

export class VmcSkeleton {
  private readonly bones = new Map<string, BonePose>();
  private root: BonePose | null = null;

  setBone(name: string, pos: Vec3, rot: Quat): void {
    this.bones.set(name, { pos, rot });
  }

  setRoot(pos: Vec3, rot: Quat): void {
    this.root = { pos, rot };
  }

  /** Head/両手が揃うまでは送出しない */
  isReady(): boolean {
    return this.bones.has('Head') && this.bones.has('LeftHand') && this.bones.has('RightHand');
  }

  private composeChain(chain: string[]): BonePose {
    let pos: Vec3 = this.root ? this.root.pos : ZERO_VEC3;
    let rot: Quat = this.root ? this.root.rot : IDENTITY_QUAT;
    for (const name of chain) {
      const bone = this.bones.get(name);
      if (!bone) continue;
      pos = addVec3(pos, rotateVec3(rot, bone.pos));
      rot = quatMul(rot, bone.rot);
    }
    return { pos, rot };
  }

  headWorld(): BonePose {
    return this.composeChain(HEAD_CHAIN);
  }

  handWorld(side: 'Left' | 'Right'): BonePose {
    return this.composeChain(HAND_CHAIN(side));
  }

  /**
   * 指ボーンのローカル回転角の合計からカール値(0..1)を見積もる。
   * VSeeFaceのハンドトラッキングは開閉中心なので回転角の量だけで十分
   */
  fingerCurls(side: 'Left' | 'Right'): FingerCurls {
    return FINGERS.map((finger) => {
      let total = 0;
      let found = false;
      for (const segment of FINGER_SEGMENTS) {
        const bone = this.bones.get(`${side}${finger}${segment}`);
        if (!bone) continue;
        found = true;
        total += quatAngle(bone.rot);
      }
      if (!found) return 0;
      const full = finger === 'Thumb' ? THUMB_FULL_CURL_ANGLE : FULL_CURL_ANGLE;
      return Math.min(1, total / full);
    }) as unknown as FingerCurls;
  }
}
