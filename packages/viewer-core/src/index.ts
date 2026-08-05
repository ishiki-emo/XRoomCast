/**
 * @xroomcast/viewer-core — VRMアバターの描画と、受信ポーズの適用。
 *
 * 「同期」(@xroomcast/sync)から届いたフレームを three.js のシーンへ反映する層。
 * 画面のUI・AR/MR・配信者コンソールは**含まない**(それらは利用側の責務)。
 * DOM要素には一切触らないので、任意のUIの下に組み込める。
 *
 * - `Avatar`            : VRMの読み込みと毎フレームの更新
 * - `PoseApplier`       : 頭・両手のポーズをVRMのボーンへ当てる(2ボーンIK込み)
 * - `IdleMotion`        : 受信が途切れたときの待機モーション
 * - `PeerPresence`      : 他の視聴者の気配(HMD・スマホ・PCの形で表示)
 * - `SpatialAudio`      : 配信者の声をアバターの位置から鳴らす
 * - `setupScenery`      : 床・ライトなど最低限の舞台
 * - `ContactShadow`     : 接地影
 * - `PlaceholderAvatar` : VRM読み込み前の仮表示
 */
export { Avatar, type RestPose } from './avatar';
export { AvatarScaleAdapter } from './avatarScale';
export { PoseApplier } from './poseApplier';
export { IdleMotion, blendPose } from './idleMotion';
export { PeerPresence, type PeerDevice, type PeerState } from './peers';
export { PlaceholderAvatar } from './placeholderAvatar';
export { SpatialAudio, isSpatialAudioSupported } from './spatialAudio';
export { VowelEstimator, type LipSyncWeights } from './lipSync';
export { setupScenery } from './scenery';
export { createStage, type Stage } from './stage';
export { ContactShadow, type ShadowMode } from './contactShadow';
export { createTwoBoneChain, solveTwoBoneIK, type TwoBoneChain } from './twoBoneIK';
