/**
 * パケット仕様(実装仕様書 §6)のエンコード/デコード。
 * リトルエンディアン。1パケット = ヘッダ(8B) + フラグの立ったセクションを順に連結。
 * viewer と bridge の両方がこのパッケージを使うこと(実装を分けない)。
 */

export const PROTOCOL_VERSION = 1;

export const SECTION_POSE = 1 << 0;
export const SECTION_EXPRESSION = 1 << 1;
export const SECTION_FINGERS = 1 << 2;
export const SECTION_DICTIONARY = 1 << 3;

export type Vec3 = [number, number, number];
export type Quat = [number, number, number, number];

/** 位置はメートル、回転はquaternion。いずれもThree.js系(右手系, Y-up)に変換済みの値(§7) */
export interface PoseNode {
  position: Vec3;
  rotation: Quat;
}

/** Head, LeftHand, RightHand の3ノード(§6.2) */
export interface PoseSection {
  head: PoseNode;
  leftHand: PoseNode;
  rightHand: PoseNode;
}

/** 表情。value は 0..1(ワイヤ上は256段階に量子化される)(§6.3) */
export interface ExpressionEntry {
  id: number;
  value: number;
}

/** 親指→小指の順。値は 0..1(ワイヤ上は256段階)(§6.4) */
export type FingerCurls = [number, number, number, number, number];

export interface FingerSection {
  leftCurls: FingerCurls;
  rightCurls: FingerCurls;
  leftSpread: number;
  rightSpread: number;
}

/** 表情ID → 表情名(§6.5) */
export interface DictionaryEntry {
  id: number;
  name: string;
}

export interface Packet {
  /** uint16。ラップアラウンド許容 */
  sequence: number;
  /** uint32。送信側単調クロック(ms) */
  timestamp: number;
  pose?: PoseSection;
  expressions?: ExpressionEntry[];
  fingers?: FingerSection;
  dictionary?: DictionaryEntry[];
}

const HEADER_SIZE = 8;
const POSE_SECTION_SIZE = 84;
const FINGER_SECTION_SIZE = 12;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/** 末尾の未知セクションを無視した警告は毎パケット出ると洪水になるため1回だけ */
let warnedTrailingBytes = false;

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function quantize255(v: number): number {
  return Math.round(clamp01(v) * 255);
}

export function encodePacket(packet: Packet): Uint8Array {
  const dictEntries = packet.dictionary?.map((e) => ({
    id: e.id,
    nameBytes: textEncoder.encode(e.name),
  }));

  let flags = 0;
  let size = HEADER_SIZE;
  if (packet.pose) {
    flags |= SECTION_POSE;
    size += POSE_SECTION_SIZE;
  }
  if (packet.expressions) {
    if (packet.expressions.length > 255) throw new Error('表情セクションは255エントリまで');
    flags |= SECTION_EXPRESSION;
    size += 1 + packet.expressions.length * 2;
  }
  if (packet.fingers) {
    flags |= SECTION_FINGERS;
    size += FINGER_SECTION_SIZE;
  }
  if (dictEntries) {
    if (dictEntries.length > 255) throw new Error('辞書セクションは255エントリまで');
    flags |= SECTION_DICTIONARY;
    size += 1 + dictEntries.reduce((sum, e) => sum + 2 + e.nameBytes.length, 0);
  }

  const bytes = new Uint8Array(size);
  const view = new DataView(bytes.buffer);
  let o = 0;

  view.setUint8(o, PROTOCOL_VERSION);
  o += 1;
  view.setUint8(o, flags);
  o += 1;
  view.setUint16(o, packet.sequence & 0xffff, true);
  o += 2;
  view.setUint32(o, packet.timestamp >>> 0, true);
  o += 4;

  if (packet.pose) {
    for (const node of [packet.pose.head, packet.pose.leftHand, packet.pose.rightHand]) {
      for (const v of node.position) {
        view.setFloat32(o, v, true);
        o += 4;
      }
      for (const v of node.rotation) {
        view.setFloat32(o, v, true);
        o += 4;
      }
    }
  }

  if (packet.expressions) {
    view.setUint8(o, packet.expressions.length);
    o += 1;
    for (const e of packet.expressions) {
      view.setUint8(o, e.id);
      o += 1;
      view.setUint8(o, quantize255(e.value));
      o += 1;
    }
  }

  if (packet.fingers) {
    for (const curl of [...packet.fingers.leftCurls, ...packet.fingers.rightCurls]) {
      view.setUint8(o, quantize255(curl));
      o += 1;
    }
    view.setUint8(o, quantize255(packet.fingers.leftSpread));
    o += 1;
    view.setUint8(o, quantize255(packet.fingers.rightSpread));
    o += 1;
  }

  if (dictEntries) {
    view.setUint8(o, dictEntries.length);
    o += 1;
    for (const e of dictEntries) {
      if (e.nameBytes.length > 255) throw new Error(`表情名が長すぎます(255バイトまで): id=${e.id}`);
      view.setUint8(o, e.id);
      o += 1;
      view.setUint8(o, e.nameBytes.length);
      o += 1;
      bytes.set(e.nameBytes, o);
      o += e.nameBytes.length;
    }
  }

  return bytes;
}

export function decodePacket(data: Uint8Array | ArrayBuffer): Packet {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < HEADER_SIZE) throw new Error('パケットが短すぎます(ヘッダ未満)');

  let o = 0;
  const version = view.getUint8(o);
  o += 1;
  if (version !== PROTOCOL_VERSION) {
    throw new Error(`未対応のプロトコルバージョン: ${version}(対応: ${PROTOCOL_VERSION})`);
  }
  const flags = view.getUint8(o);
  o += 1;
  const sequence = view.getUint16(o, true);
  o += 2;
  const timestamp = view.getUint32(o, true);
  o += 4;

  const packet: Packet = { sequence, timestamp };

  if (flags & SECTION_POSE) {
    const readNode = (): PoseNode => {
      const position: Vec3 = [
        view.getFloat32(o, true),
        view.getFloat32(o + 4, true),
        view.getFloat32(o + 8, true),
      ];
      const rotation: Quat = [
        view.getFloat32(o + 12, true),
        view.getFloat32(o + 16, true),
        view.getFloat32(o + 20, true),
        view.getFloat32(o + 24, true),
      ];
      o += 28;
      return { position, rotation };
    };
    packet.pose = { head: readNode(), leftHand: readNode(), rightHand: readNode() };
  }

  if (flags & SECTION_EXPRESSION) {
    const count = view.getUint8(o);
    o += 1;
    const expressions: ExpressionEntry[] = [];
    for (let i = 0; i < count; i++) {
      expressions.push({ id: view.getUint8(o), value: view.getUint8(o + 1) / 255 });
      o += 2;
    }
    packet.expressions = expressions;
  }

  if (flags & SECTION_FINGERS) {
    const curl = (i: number) => view.getUint8(o + i) / 255;
    packet.fingers = {
      leftCurls: [curl(0), curl(1), curl(2), curl(3), curl(4)],
      rightCurls: [curl(5), curl(6), curl(7), curl(8), curl(9)],
      leftSpread: curl(10),
      rightSpread: curl(11),
    };
    o += FINGER_SECTION_SIZE;
  }

  if (flags & SECTION_DICTIONARY) {
    const count = view.getUint8(o);
    o += 1;
    const dictionary: DictionaryEntry[] = [];
    for (let i = 0; i < count; i++) {
      const id = view.getUint8(o);
      o += 1;
      const len = view.getUint8(o);
      o += 1;
      dictionary.push({ id, name: textDecoder.decode(bytes.subarray(o, o + len)) });
      o += len;
    }
    packet.dictionary = dictionary;
  }

  if (o > bytes.byteLength) {
    throw new Error(`パケットが短すぎます(必要 ${o} バイト、実際 ${bytes.byteLength} バイト)`);
  }

  // 既知セクションを読み終えた後に残るバイトは、将来のセクション(§6.6)とみなして無視する。
  // 旧デコーダを落とさずにセクションを末尾追加できるようにするための互換ルール。
  if (o < bytes.byteLength && !warnedTrailingBytes) {
    warnedTrailingBytes = true;
    console.warn(
      `[protocol] 末尾の未知セクション(${bytes.byteLength - o} バイト)を無視しました。送信側がこちらの知らない新しいセクションを送っています(この警告は初回のみ)`,
    );
  }

  return packet;
}
