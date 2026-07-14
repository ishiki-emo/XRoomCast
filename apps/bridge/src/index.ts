/**
 * VMCブリッジ(実装仕様書 §5 Phase 2b)。
 * UDPでVMC(OSC)を受信 → Head/両手をFK合成+座標系変換(§7)→ §6形式に
 * シリアライズ → 同居のWebSocketサーバーへブロードキャストする。
 * 送信レート: ポーズ30Hz、表情・手指15Hz(受信レートが高くても間引く)。
 */
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import {
  encodePacket,
  type DictionaryEntry,
  type ExpressionEntry,
  type Packet,
  type PoseNode,
} from '@vrmsync/protocol';
import { unityToThreePos, unityToThreeQuat } from './math.js';
import type { Quat, Vec3 } from '@vrmsync/protocol';
import { VmcSkeleton } from './skeleton.js';
import { normalizeBlendName } from './blendNames.js';
import { startVmcReceiver } from './vmcReceiver.js';
import { DATA_CHANNEL_NAME, SfuApi, SfuPublisher } from './sfu.js';

// リポジトリルートの .env を読む(App Secretをコード・ブラウザに出さないため)
try {
  process.loadEnvFile(fileURLToPath(new URL('../../../.env', import.meta.url)));
} catch {
  // .envが無ければ環境変数のみで動く
}

const VMC_PORT = Number(process.env.VMC_PORT ?? 39539);
const WS_PORT = Number(process.env.WS_PORT ?? 8080);
const POSE_INTERVAL_MS = 1000 / 30;
/** /vrm/ ルートで配信するVRMの置き場所(ビューアのpublicと共用) */
const VRM_DIR = fileURLToPath(new URL('../../viewer/public', import.meta.url));

// ---- 受信状態 ----
const skeleton = new VmcSkeleton();
/** Blend/Applyで確定した表情値(VRM1.0名) */
const blendCommitted = new Map<string, number>();
/** Blend/Valで届いた未確定の表情値 */
const blendPending = new Map<string, number>();
/** 表情名 → ワイヤ上の表情ID */
const dictionary = new Map<string, number>();
let dictionaryDirty = false;
/** 前回送信した量子化済み表情値(デルタ送信用) */
const lastSentExpression = new Map<number, number>();

const stats = { received: 0, sent: 0, bytes: 0, suppressed: 0 };

/**
 * フレームアトミック化: VMCはボーン群を複数UDPパケットに分けて送るため、
 * 受信の途中でFK合成すると新旧フレーム混成の破綻ポーズができる。
 * /VMC/Ext/T(フレーム区切り)まで溜めてから一括反映する。
 * 区切りを送らない送信元のために、1秒以上区切りが来なければ即時反映へフォールバック
 */
const pendingBones = new Map<string, { pos: Vec3; rot: Quat }>();
let lastFrameMarkerAt = -Infinity;

/** VMC送信元(addr:port)→最終受信時刻。複数送信元の混線検出用 */
const senders = new Map<string, number>();

/**
 * スパイクフィルタ: 1tick(約33ms)で0.4m以上跳んだ位置は誤検出とみなし前回値を保持する。
 * 3tick連続で跳び先に居続けたら本物の移動として受理する(遅延100ms相当)
 */
const SPIKE_THRESHOLD_M = 0.4;
const SPIKE_ACCEPT_TICKS = 3;

function createSpikeFilter(label: string) {
  let last: Vec3 | null = null;
  let outlierTicks = 0;
  return (pos: Vec3): Vec3 => {
    if (last === null) {
      last = pos;
      return pos;
    }
    const d = Math.hypot(pos[0] - last[0], pos[1] - last[1], pos[2] - last[2]);
    if (d > SPIKE_THRESHOLD_M) {
      outlierTicks += 1;
      if (outlierTicks < SPIKE_ACCEPT_TICKS) {
        stats.suppressed += 1;
        return last;
      }
      console.log(`[filter] ${label} の大きな移動(${d.toFixed(2)}m)を受理(${outlierTicks}tick継続)`);
    }
    outlierTicks = 0;
    last = pos;
    return pos;
  };
}

const spikeFilters = {
  head: createSpikeFilter('Head'),
  leftHand: createSpikeFilter('LeftHand'),
  rightHand: createSpikeFilter('RightHand'),
};

function dictionaryId(name: string): number {
  let id = dictionary.get(name);
  if (id === undefined) {
    if (dictionary.size >= 256) {
      console.warn(`[bridge] 表情辞書が256件を超えたため無視: ${name}`);
      return -1;
    }
    id = dictionary.size;
    dictionary.set(name, id);
    dictionaryDirty = true;
    console.log(`[bridge] 表情を登録: id=${id} name=${name}`);
  }
  return id;
}

startVmcReceiver(VMC_PORT, {
  onBone: (name, pos, rot) => {
    if (performance.now() - lastFrameMarkerAt < 1000) {
      pendingBones.set(name, { pos, rot });
    } else {
      skeleton.setBone(name, pos, rot); // フレーム区切りが来ない送信元向け
    }
  },
  onFrameEnd: () => {
    lastFrameMarkerAt = performance.now();
    for (const [name, bone] of pendingBones) skeleton.setBone(name, bone.pos, bone.rot);
    pendingBones.clear();
  },
  onRoot: (pos, rot) => skeleton.setRoot(pos, rot),
  onBlendValue: (name, value) => blendPending.set(normalizeBlendName(name), value),
  onBlendApply: () => {
    for (const [name, value] of blendPending) {
      blendCommitted.set(name, value);
      dictionaryId(name);
    }
    blendPending.clear();
  },
  onMessage: () => {
    stats.received += 1;
  },
  onSender: (sender) => {
    senders.set(sender, performance.now());
  },
});

// ---- Cloudflare Realtime SFU(Phase 2c) ----
const sfuConfig =
  process.env.CF_REALTIME_APP_ID && process.env.CF_REALTIME_APP_SECRET
    ? { appId: process.env.CF_REALTIME_APP_ID, appSecret: process.env.CF_REALTIME_APP_SECRET }
    : null;
const sfuApi = sfuConfig ? new SfuApi(sfuConfig) : null;
const publisher = sfuApi ? new SfuPublisher(sfuApi) : null;
if (publisher) {
  void publisher.connectWithRetry();
} else {
  console.log('[sfu] CF_REALTIME_APP_ID / CF_REALTIME_APP_SECRET 未設定のためSFUは無効(WS配信のみ)');
}

// ---- HTTP API(ビューア向けSFUプロキシ。App Secretをブラウザに出さない)+ WebSocket配信 ----
function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

async function handleHttp(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  try {
    if (req.method === 'GET' && req.url === '/api/sfu/status') {
      sendJson(res, 200, {
        enabled: sfuApi !== null,
        publisherReady: publisher?.ready ?? false,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sfu/sessions/new') {
      if (!sfuApi) {
        sendJson(res, 503, { error: 'SFU未設定(.envにCF_REALTIME_APP_ID/SECRETを設定)' });
        return;
      }
      const body = await readJsonBody(req);
      const session = await sfuApi.newSession(String(body.sdp));
      sendJson(res, 200, { sessionId: session.sessionId, sdp: session.sessionDescription.sdp });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/sfu/subscribe') {
      if (!sfuApi || !publisher?.sessionId) {
        sendJson(res, 503, { error: 'パブリッシャーが未接続です(ブリッジのログを確認)' });
        return;
      }
      const body = await readJsonBody(req);
      const result = await sfuApi.newDataChannels(String(body.sessionId), [
        { location: 'remote', sessionId: publisher.sessionId, dataChannelName: DATA_CHANNEL_NAME },
      ]);
      const channelId = result.dataChannels[0]?.id;
      if (channelId === undefined) {
        sendJson(res, 502, { error: 'DataChannel IDが取得できませんでした' });
        return;
      }
      sendJson(res, 200, { id: channelId, name: DATA_CHANNEL_NAME });
      return;
    }
    // VRM配信: apps/viewer/public/ の .vrm をCORS付きで配る。
    // 公開ビューア(HTTPS)からトンネル経由で読み込むための簡易ホスティング
    if (req.method === 'GET' && req.url?.startsWith('/vrm/')) {
      const name = path.basename(decodeURIComponent(req.url.slice('/vrm/'.length)));
      if (!name.toLowerCase().endsWith('.vrm')) {
        sendJson(res, 404, { error: 'not found' });
        return;
      }
      const filePath = path.join(VRM_DIR, name);
      if (!existsSync(filePath)) {
        sendJson(res, 404, { error: `${name} がありません(${VRM_DIR} に置いてください)` });
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': statSync(filePath).size,
        'Cache-Control': 'no-store',
      });
      createReadStream(filePath).pipe(res);
      return;
    }
    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { error: String(error) });
  }
}

const server = http.createServer((req, res) => {
  void handleHttp(req, res);
});
const wss = new WebSocketServer({ server });
server.listen(WS_PORT, () => {
  console.log(`[ws] 配信待機: ws://localhost:${WS_PORT}(SFUプロキシAPI同居)`);
});

let sequence = 0;

function nextSequence(): number {
  sequence = (sequence + 1) & 0xffff;
  return sequence;
}

function timestamp(): number {
  return Math.round(performance.now()) >>> 0;
}

function quantize(v: number): number {
  return Math.round(Math.min(1, Math.max(0, v)) * 255);
}

function fullDictionary(): DictionaryEntry[] {
  return [...dictionary.entries()].map(([name, id]) => ({ id, name }));
}

function fullExpressions(): ExpressionEntry[] {
  return [...blendCommitted.entries()]
    .map(([name, value]) => ({ id: dictionary.get(name) ?? -1, value }))
    .filter((e) => e.id >= 0);
}

/** 変化のあった表情のみ(デルタ方式 §6.3)。送信済みとして記録もする */
function deltaExpressions(): ExpressionEntry[] {
  const delta: ExpressionEntry[] = [];
  for (const [name, value] of blendCommitted) {
    const id = dictionary.get(name);
    if (id === undefined) continue;
    const q = quantize(value);
    if (lastSentExpression.get(id) !== q) {
      lastSentExpression.set(id, q);
      delta.push({ id, value });
    }
  }
  return delta;
}

function poseNode(
  world: { pos: Vec3; rot: Quat },
  filter: (pos: Vec3) => Vec3,
): PoseNode {
  return { position: filter(unityToThreePos(world.pos)), rotation: unityToThreeQuat(world.rot) };
}

function broadcast(bytes: Uint8Array): void {
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(bytes);
      stats.bytes += bytes.byteLength;
    }
  }
  if (publisher?.ready) {
    publisher.send(bytes);
    stats.bytes += bytes.byteLength;
  }
  stats.sent += 1;
}

// 辞書の定期再送(§6.5: 2cでは5秒間隔。SFUは一方向で途中参加者に接続時送信ができない)。
// 合わせて表情の送信済み記録もクリアし、次のtickで全表情値が再送されるようにする
setInterval(() => {
  if (dictionary.size === 0) return;
  dictionaryDirty = true;
  lastSentExpression.clear();
}, 5000);

wss.on('connection', (client, request) => {
  console.log(`[ws] クライアント接続: ${request.socket.remoteAddress}(計${wss.clients.size}件)`);
  // 接続時は辞書と現在の表情の全量を送る(§6.5: 2bでは接続時に必ず辞書を送信)
  const welcome: Packet = {
    sequence: nextSequence(),
    timestamp: timestamp(),
    dictionary: fullDictionary(),
    expressions: fullExpressions(),
  };
  client.send(encodePacket(welcome));
  client.on('close', () => {
    console.log(`[ws] クライアント切断(計${wss.clients.size}件)`);
  });
});

// ---- 送信ループ(30Hz。表情・手指は2回に1回=15Hz) ----
// WindowsのsetIntervalは分解能が粗く(約15.6ms)33ms指定では22Hz程度に落ちるため、
// 細かいタイマーで回して絶対時刻基準で送信判定する
let tickCount = 0;
let nextSendAt = performance.now();
setInterval(() => {
  const now = performance.now();
  if (now < nextSendAt) return;
  nextSendAt += POSE_INTERVAL_MS;
  if (now - nextSendAt > 1000) nextSendAt = now; // 長時間の停止後は追い付き送信しない

  if (!skeleton.isReady()) return; // VMCが届くまで送らない

  const packet: Packet = {
    sequence: nextSequence(),
    timestamp: timestamp(),
    pose: {
      head: poseNode(skeleton.headWorld(), spikeFilters.head),
      leftHand: poseNode(skeleton.handWorld('Left'), spikeFilters.leftHand),
      rightHand: poseNode(skeleton.handWorld('Right'), spikeFilters.rightHand),
    },
  };

  tickCount += 1;
  if (tickCount % 2 === 0) {
    packet.fingers = {
      leftCurls: skeleton.fingerCurls('Left'),
      rightCurls: skeleton.fingerCurls('Right'),
      leftSpread: 0.5, // VSeeFaceは指の開きを取らないため中立固定
      rightSpread: 0.5,
    };
    const delta = deltaExpressions();
    if (delta.length > 0) packet.expressions = delta;
    if (dictionaryDirty) {
      packet.dictionary = fullDictionary();
      dictionaryDirty = false;
    }
  }

  broadcast(encodePacket(packet));
}, 4);

// ---- 統計ログ(毎秒) ----
setInterval(() => {
  const kb = (stats.bytes / 1024).toFixed(1);
  const suppressed = stats.suppressed > 0 ? ` | スパイク抑制 ${stats.suppressed}件` : '';
  const sfuState = publisher ? ` | SFU ${publisher.ready ? '配信中' : '接続中...'}` : '';
  console.log(
    `[stats] 受信 ${stats.received} msg/s | 送信 ${stats.sent} pkt/s | ${kb} KB/s | WS ${wss.clients.size}件${sfuState}${suppressed}`,
  );
  stats.received = 0;
  stats.sent = 0;
  stats.bytes = 0;
  stats.suppressed = 0;

  // 混線検出: 直近5秒に2つ以上の送信元からVMCが届いていたら警告
  // (例: VSeeFaceとシミュレータの同時送信。ポーズが交互に上書きされて暴れる)
  const now = performance.now();
  for (const [sender, lastSeen] of senders) {
    if (now - lastSeen > 5000) senders.delete(sender);
  }
  if (senders.size >= 2) {
    console.warn(
      `[警告] 複数のVMC送信元を受信中(${[...senders.keys()].join(', ')})。` +
        'ポーズが混線して暴れます。片方(シミュレータ等)を停止してください',
    );
  }
}, 1000);

console.log(`[bridge] 起動しました(VMC_PORT=${VMC_PORT}, WS_PORT=${WS_PORT})`);
console.log('[bridge] VSeeFace側: 設定 → OSC/VMCプロトコル → 送信を有効化, ポート39539');
