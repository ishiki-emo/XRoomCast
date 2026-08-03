/**
 * @xroomcast/sync — ポーズ同期の中核。**描画エンジンにも特定のサーバーにも依存しない。**
 *
 * 中身は3つ:
 * 1. トランスポート抽象(`Transport`)と、その実装2種
 *    - `WebSocketTransport`: ブリッジ直結(ローカル開発・LAN)
 *    - `SfuTransport`: Cloudflare Realtime SFU 経由(インターネット公開)
 *    Cloudflareは**選べる実装の1つ**であり、前提ではない。自前のサーバーで
 *    回したい場合はこの `Transport` を実装すればコアはそのまま動く
 * 2. ジッタバッファ(`PoseStreamPlayer`)。受信パケットを目標遅延100msで補間再生する
 * 3. 資格情報の抽象(`AuthProvider`)とルーム名の規則
 *
 * three / three-vrm には依存しない。VRMへ実際にポーズを当てるのは
 * @xroomcast/viewer-core の役目。
 */
export type { Transport } from './transport';
export { WebSocketTransport } from './wsTransport';
export { SfuTransport } from './sfuTransport';
export { PoseStreamPlayer, TARGET_DELAY_MS, type SampledFrame } from './poseStream';
export { anonymousAuth, bearerAuth, withAuth, type AuthProvider } from './auth';
export { DEFAULT_ROOM, normalizeRoom, withRoom } from './room';
