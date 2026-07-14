/**
 * 2ボーンIKの自前実装(実装仕様書 §5 Phase 2a パイプライン3)。
 * upperArm–lowerArm–hand(または upperLeg–lowerLeg–foot)のチェーンを解析的に解く:
 * 到達距離から余弦定理で中間関節(肘/膝)の位置を確定し、ポールベクトル側に向けてから
 * 上節・下節をエイム、最後に末端(手首/足首)のワールド回転を目標値に合わせる。
 * three-vrmの正規化ボーン(レスト=Tポーズ、ローカル回転単位元)を前提とする。
 */
import * as THREE from 'three';

export interface TwoBoneChain {
  upper: THREE.Object3D;
  lower: THREE.Object3D;
  /** チェーン末端(手首/足首) */
  end: THREE.Object3D;
  upperLen: number;
  lowerLen: number;
  /** レスト時の子ボーン方向(そのボーンのローカル空間、正規化済み) */
  upperRestDir: THREE.Vector3;
  lowerRestDir: THREE.Vector3;
}

const _aimParentQuat = new THREE.Quaternion();
const _aimDirLocal = new THREE.Vector3();
const _worldScale = new THREE.Vector3();
const _rootPos = new THREE.Vector3();
const _toTarget = new THREE.Vector3();
const _poleDir = new THREE.Vector3();
const _elbowPos = new THREE.Vector3();
const _elbowDir = new THREE.Vector3();
const _handDir = new THREE.Vector3();
const _handParentQuat = new THREE.Quaternion();

/** レスト姿勢(Tポーズ)のうちに呼んでボーン長とレスト方向を記録する */
export function createTwoBoneChain(
  upper: THREE.Object3D | null,
  lower: THREE.Object3D | null,
  end: THREE.Object3D | null,
): TwoBoneChain | null {
  if (!upper || !lower || !end) return null;
  const upperLen = lower.position.length();
  const lowerLen = end.position.length();
  if (upperLen < 1e-6 || lowerLen < 1e-6) return null;
  return {
    upper,
    lower,
    end,
    upperLen,
    lowerLen,
    upperRestDir: lower.position.clone().normalize(),
    lowerRestDir: end.position.clone().normalize(),
  };
}

/** boneのローカル回転を、子のレスト方向がワールドのtargetDirを向くように設定する */
function aimBone(bone: THREE.Object3D, restDirLocal: THREE.Vector3, targetDirWorld: THREE.Vector3): void {
  bone.parent!.getWorldQuaternion(_aimParentQuat);
  _aimDirLocal.copy(targetDirWorld).applyQuaternion(_aimParentQuat.invert()).normalize();
  bone.quaternion.setFromUnitVectors(restDirLocal, _aimDirLocal);
}

/**
 * @param targetPos 末端のワールド目標位置
 * @param targetQuat 末端のワールド目標回転
 * @param polePos 中間関節(肘/膝)を向けるポール位置(ワールド)
 */
export function solveTwoBoneIK(
  chain: TwoBoneChain,
  targetPos: THREE.Vector3,
  targetQuat: THREE.Quaternion,
  polePos: THREE.Vector3,
): void {
  chain.upper.getWorldPosition(_rootPos);
  _toTarget.copy(targetPos).sub(_rootPos);
  if (_toTarget.lengthSq() < 1e-10) return;

  // 配置フレームの均一スケール(卓上モード等)をボーン長に反映する
  chain.upper.getWorldScale(_worldScale);
  const scale = _worldScale.x || 1;
  const upperLen = chain.upperLen * scale;
  const lowerLen = chain.lowerLen * scale;

  // 到達可能距離にクランプ(伸び切り・折り畳み切りの特異点を避ける)
  const d = THREE.MathUtils.clamp(
    _toTarget.length(),
    Math.abs(upperLen - lowerLen) + 1e-4 * scale,
    upperLen + lowerLen - 1e-4 * scale,
  );
  _toTarget.normalize();

  // 余弦定理: 目標方向軸上の肘の足の位置 x と、軸からの高さ h
  const x = (d * d + upperLen * upperLen - lowerLen * lowerLen) / (2 * d);
  const h = Math.sqrt(Math.max(upperLen * upperLen - x * x, 0));

  // ポール方向(目標方向軸に直交する成分)へ肘を出す
  _poleDir.copy(polePos).sub(_rootPos);
  _poleDir.addScaledVector(_toTarget, -_poleDir.dot(_toTarget));
  if (_poleDir.lengthSq() < 1e-8) {
    // ポールが軸上に乗った場合のフォールバック: 下方向を基準に直交ベクトルを作る
    _poleDir.set(0, -1, 0).addScaledVector(_toTarget, _toTarget.y);
    if (_poleDir.lengthSq() < 1e-8) _poleDir.set(0, 0, -1);
  }
  _poleDir.normalize();

  _elbowPos.copy(_rootPos).addScaledVector(_toTarget, x).addScaledVector(_poleDir, h);

  // 上腕を肘へ、前腕を手首目標へ順にエイム(親の更新が子のワールド行列に反映される)
  _elbowDir.copy(_elbowPos).sub(_rootPos);
  aimBone(chain.upper, chain.upperRestDir, _elbowDir);

  chain.lower.getWorldPosition(_elbowPos);
  _handDir.copy(targetPos).sub(_elbowPos);
  aimBone(chain.lower, chain.lowerRestDir, _handDir);

  // 末端(手首/足首): ワールド回転を目標値に一致させる
  chain.end.parent!.getWorldQuaternion(_handParentQuat);
  chain.end.quaternion.copy(_handParentQuat.invert().multiply(targetQuat));
}
