/**
 * ダミーモーションを§6形式のバイナリ列としてファイル保存し、
 * デコードし直して再生(検証)するCLI。
 * ファイル形式: (uint32 LE パケット長 + パケット本体) の繰り返し。
 *
 * 実行: npm run generate:motion(リポジトリルート)
 */
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decodePacket, encodePacket } from '@xroomcast/protocol';
import { dummyPacketAt, POSE_INTERVAL_MS, POSE_RATE } from './dummyMotion.js';

const DURATION_MS = 10_000;
const OUT_PATH = fileURLToPath(new URL('../dummy-motion.bin', import.meta.url));

const frames: Uint8Array[] = [];
let payloadBytes = 0;
let packetCount = 0;

for (let seq = 0; seq * POSE_INTERVAL_MS < DURATION_MS; seq++) {
  const tMs = seq * POSE_INTERVAL_MS;
  const bin = encodePacket(dummyPacketAt(tMs, seq));

  const framed = new Uint8Array(4 + bin.length);
  new DataView(framed.buffer).setUint32(0, bin.length, true);
  framed.set(bin, 4);
  frames.push(framed);

  payloadBytes += bin.length;
  packetCount += 1;
}

const total = new Uint8Array(frames.reduce((sum, f) => sum + f.length, 0));
let offset = 0;
for (const f of frames) {
  total.set(f, offset);
  offset += f.length;
}
writeFileSync(OUT_PATH, total);

// 再生検証: 全パケットをデコードし直してタイムスタンプの単調増加を確認
let prevTs = -1;
let readOffset = 0;
const readView = new DataView(total.buffer);
while (readOffset < total.length) {
  const len = readView.getUint32(readOffset, true);
  readOffset += 4;
  const packet = decodePacket(total.subarray(readOffset, readOffset + len));
  readOffset += len;
  if (packet.timestamp <= prevTs) {
    throw new Error(`タイムスタンプが単調増加していません: ${prevTs} -> ${packet.timestamp}`);
  }
  prevTs = packet.timestamp;
}

console.log(`書き出し: ${OUT_PATH}`);
console.log(`  ${DURATION_MS / 1000}秒分 / ${packetCount}パケット (ポーズ${POSE_RATE}Hz)`);
console.log(`  ペイロード計 ${payloadBytes.toLocaleString()} バイト`);
console.log(`  平均ビットレート ${((payloadBytes / (DURATION_MS / 1000)) / 1024).toFixed(1)} KB/s`);
console.log(`  デコード検証OK(${packetCount}パケット、タイムスタンプ単調増加)`);
