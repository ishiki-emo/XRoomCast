/**
 * 配信モーションが届いていないときにクライアント側だけで動かす待機モーション。
 * サーバーからは何も送られず、経過時刻の純関数として生成する。
 *
 * 出力は受信ストリームと同じ SampledFrame なので、PoseApplier のIK・足接地・
 * 配置フレーム追従(AR設置/卓上スケール)がそのまま効く。基準位置はモデルごとの
 * レスト姿勢(Avatar.restPose)から取るため、身長や腕の長さが違っても破綻しない。
 *
 * 周期は互いに素に近い値を選び、合成波が短い間隔で繰り返して見えないようにしている。
 */
import * as THREE from 'three';
import type { FingerCurls, PoseNode, Quat } from '@xroomcast/protocol';
import type { SampledFrame } from '@xroomcast/sync';
import type { RestPose } from './avatar';

const TWO_PI = Math.PI * 2;

/** 呼吸・体重移動・頭の揺れの周期(秒)。割り切れない比にする */
const BREATH_SEC = 4.3;
const SWAY_SEC = 9.1;
const HEAD_YAW_SEC = 7.3;
const HEAD_ROLL_SEC = 5.9;
const HEAD_PITCH_SEC = 11.7;
const HAND_SEC = 6.7;

/** まばたきの間隔(秒)と1回あたりの長さ(秒) */
const BLINK_INTERVAL_SEC = 4.1;
const BLINK_DURATION_SEC = 0.14;

const _q = new THREE.Quaternion();
const _qHead = new THREE.Quaternion();
const _euler = new THREE.Euler();

function quatToArray(q: THREE.Quaternion): Quat {
  return [q.x, q.y, q.z, q.w];
}

/**
 * まばたき。等間隔だと機械的に見えるので、間隔を疑似乱数で少し揺らす。
 * 時刻の純関数を保つため Math.random は使わない
 */
function blinkAt(t: number): number {
  const index = Math.floor(t / BLINK_INTERVAL_SEC);
  // インデックスから決まる 0〜1 の疑似乱数(同じindexなら常に同じ値)
  const jitter = (Math.sin(index * 127.1) * 43758.5453) % 1;
  const start = index * BLINK_INTERVAL_SEC + Math.abs(jitter) * (BLINK_INTERVAL_SEC * 0.6);
  const elapsed = t - start;
  if (elapsed < 0 || elapsed > BLINK_DURATION_SEC) return 0;
  // 閉じて開くまでを sin の山ひとつで表す
  return Math.sin((elapsed / BLINK_DURATION_SEC) * Math.PI);
}

export class IdleMotion {
  private readonly expressions = new Map<string, number>();

  /**
   * @param elapsedMs 待機モーションの経過時間(ms)
   */
  sample(elapsedMs: number, rest: RestPose): SampledFrame {
    const t = elapsedMs / 1000;
    const h = rest.height;

    // 呼吸: 頭がわずかに上下する。体重移動: ゆっくり左右へ
    const breath = Math.sin((TWO_PI * t) / BREATH_SEC);
    const sway = Math.sin((TWO_PI * t) / SWAY_SEC);

    const headPos = new THREE.Vector3(
      rest.head.x + sway * h * 0.012,
      rest.head.y + breath * h * 0.006,
      rest.head.z + Math.sin((TWO_PI * t) / (BREATH_SEC * 1.7)) * h * 0.004,
    );

    // 頭の向き: ヨー・ロール・ピッチを別周期で合成してゆっくり見回す
    const yaw = 0.055 * Math.sin((TWO_PI * t) / HEAD_YAW_SEC);
    const roll = 0.03 * Math.sin((TWO_PI * t) / HEAD_ROLL_SEC + 1.1);
    const pitch = 0.025 * Math.sin((TWO_PI * t) / HEAD_PITCH_SEC + 0.4);
    _euler.set(pitch, yaw, roll, 'YXZ');
    _qHead.setFromEuler(_euler);

    const hand = (side: 'left' | 'right'): PoseNode => {
      const sign = side === 'left' ? 1 : -1;
      const base = side === 'left' ? rest.leftHand : rest.rightHand;
      const phase = side === 'left' ? 0 : 2.2; // 左右で位相をずらす
      const swing = Math.sin((TWO_PI * t) / HAND_SEC + phase);
      // 腕を下ろした姿勢: レスト(Tポーズ)から前腕を下へ倒す回転
      _q.setFromEuler(
        _euler.set(
          0,
          // 手のひらを軽く体側へ向ける
          sign * -0.85,
          sign * (-Math.PI / 2 + 0.06 * swing),
          'YXZ',
        ),
      );
      return {
        position: [
          base.x + sway * h * 0.008 + sign * swing * h * 0.004,
          base.y + breath * h * 0.005,
          base.z + swing * h * 0.006,
        ],
        rotation: quatToArray(_q),
      };
    };

    this.expressions.set('blink', blinkAt(t));

    // 指はごく軽く曲げて自然な手にする(完全に開いた手は硬く見える)
    const curl = 0.16 + 0.02 * breath;
    const curls: FingerCurls = [curl * 0.7, curl, curl, curl, curl * 1.1];

    return {
      pose: {
        head: { position: [headPos.x, headPos.y, headPos.z], rotation: quatToArray(_qHead) },
        leftHand: hand('left'),
        rightHand: hand('right'),
      },
      expressions: this.expressions,
      fingers: {
        leftCurls: [...curls] as FingerCurls,
        rightCurls: [...curls] as FingerCurls,
        leftSpread: 0.35,
        rightSpread: 0.35,
      },
    };
  }
}

/** ふたつのフレームのポーズを補間する(待機↔配信の切り替えを滑らかにする) */
export function blendPose(from: SampledFrame, to: SampledFrame, t: number): SampledFrame {
  if (!from.pose || !to.pose) return t < 0.5 ? from : to;
  const ratio = THREE.MathUtils.clamp(t, 0, 1);
  const node = (a: PoseNode, b: PoseNode): PoseNode => {
    const out: number[] = [0, 0, 0, 1];
    THREE.Quaternion.slerpFlat(
      out,
      0,
      a.rotation as unknown as number[],
      0,
      b.rotation as unknown as number[],
      0,
      ratio,
    );
    return {
      position: [
        a.position[0] + (b.position[0] - a.position[0]) * ratio,
        a.position[1] + (b.position[1] - a.position[1]) * ratio,
        a.position[2] + (b.position[2] - a.position[2]) * ratio,
      ],
      rotation: out as Quat,
    };
  };
  return {
    // 表情・手指は切り替え先を優先する(急変しても目立ちにくい)
    expressions: to.expressions ?? from.expressions,
    fingers: to.fingers ?? from.fingers,
    // 体は補間せず途中で切り替える(待機側には体が無く、腰の推定方式ごと変わるため)
    body: ratio < 0.5 ? from.body : to.body,
    pose: {
      head: node(from.pose.head, to.pose.head),
      leftHand: node(from.pose.leftHand, to.pose.leftHand),
      rightHand: node(from.pose.rightHand, to.pose.rightHand),
    },
  };
}
