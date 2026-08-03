/**
 * 満員・停止中の扱いを固定する。
 *
 * 満員は「新しく入れない」であって「いま見ている人が見られない」ではない。
 * これを取り違えて、満員になった瞬間に**視聴者全員が追い出される**不具合が出た。
 * 停止中は配信者の意思なので、逆に繋がっていても畳む。
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SfuTransport } from '../src/sfuTransport';

// ブラウザ向けのパッケージなので、待機処理が使う最小限を用意する
const globals = globalThis as unknown as Record<string, unknown>;
globals.window ??= {
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
  setInterval: globalThis.setInterval.bind(globalThis),
  clearInterval: globalThis.clearInterval.bind(globalThis),
};
globals.document ??= {
  visibilityState: 'visible',
  addEventListener: () => {},
  removeEventListener: () => {},
};

interface Internals {
  pc: unknown;
  channelOpen: boolean;
  mySessionId: string | null;
  subscribedPublisher: string | null;
  lastPacketAt: number;
  fetchStatus: () => Promise<unknown>;
  startIdlePoll: (generation: number) => void;
  generation: number;
}

function setup(status: Record<string, unknown>, connected: boolean) {
  const reasons: (string | null)[] = [];
  let closed = false;

  const transport = new SfuTransport('http://test');
  transport.onUnavailable = (reason) => reasons.push(reason);

  const internals = transport as unknown as Internals;
  internals.pc = connected
    ? { close: () => { closed = true; }, getReceivers: () => [] }
    : null;
  internals.channelOpen = connected;
  internals.mySessionId = connected ? 'viewer' : null;
  internals.subscribedPublisher = connected ? 'publisher-1' : null;
  internals.lastPacketAt = performance.now();
  internals.fetchStatus = () => Promise.resolve(status);

  return { transport, internals, reasons, wasClosed: () => closed };
}

/** 無受信の様子見を1周ぶん回す */
async function pollOnce(h: ReturnType<typeof setup>): Promise<void> {
  h.internals.startIdlePoll(h.internals.generation);
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

const FULL = { unavailable: 'full', publisherReady: true, publisherSessionId: 'publisher-1' };
const STOPPED = { unavailable: 'stopped', publisherReady: true, publisherSessionId: 'publisher-1' };

describe('満員・停止中の扱い', () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup(FULL, true);
  });

  it('満員でも、既に繋がっている視聴者は追い出さない', async () => {
    await pollOnce(h);
    expect(h.reasons).not.toContain('full');
    expect(h.wasClosed()).toBe(false);
  });

  it('満員のとき、まだ繋がっていない視聴者には理由を伝える', async () => {
    const fresh = setup(FULL, false);
    await pollOnce(fresh);
    expect(fresh.reasons).toContain('full');
  });

  it('入室証が後から届いたら、待たずに再確認する', async () => {
    // 入室証は presence 経由なのでSFUの接続開始に間に合わないことがある。
    // 次のポーリング(最大2分)まで満員表示のままにしてはいけない
    const late = setup(FULL, false);
    const internals = late.internals as unknown as { started: boolean; open: () => Promise<void> };
    internals.started = true;
    let reopened = 0;
    internals.open = () => {
      reopened += 1;
      return Promise.resolve();
    };

    await pollOnce(late);
    expect(late.reasons).toContain('full');

    late.transport.setAdmission('later-token');
    expect(reopened).toBe(1);
  });

  it('停止中は、繋がっている視聴者も畳む(配信者の意思なので)', async () => {
    const stopped = setup(STOPPED, true);
    await pollOnce(stopped);
    expect(stopped.reasons).toContain('stopped');
    expect(stopped.wasClosed()).toBe(true);
  });
});
