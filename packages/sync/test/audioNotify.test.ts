/**
 * 配信者がマイクを入れ直したときに、視聴側が「正しいトラック」を通知することを固定する。
 *
 * 配信者コンソールはマイクONのたびに新しい配信セッションを作るため、視聴側の
 * PeerConnectionには**古い(終了した)トラックのトランシーバが残ったまま**
 * 新しいものが増える。ここで扱いを誤ると次の症状になる。実際に両方出た。
 *
 * - 受信トラックの先頭を拾う → 死んだトラックを掴んで**無音**
 * - ontrack が通知した後に上書きする → 同上
 * - 停止時に記録を消さない → 同一オブジェクトが重複判定で弾かれ**通知が来ない**
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { SfuTransport } from '../src/sfuTransport';

type FakeTrack = { kind: string; id: string; readyState: 'live' | 'ended' };

const makeTrack = (id: string, readyState: 'live' | 'ended' = 'live'): FakeTrack => ({
  kind: 'audio',
  id,
  readyState,
});

interface Harness {
  transport: SfuTransport;
  notified: (string | null)[];
  /** SFUが再ネゴシエーションを要求するか */
  renegotiate: boolean;
  /** いま PeerConnection にぶら下がっている音声トラック(古い順) */
  receivers: FakeTrack[];
  /** 再ネゴシエーション時に ontrack が発火する想定のトラック */
  ontrackTrack: FakeTrack | null;
}

function setup(): Harness {
  const h = { renegotiate: true, receivers: [], ontrackTrack: null } as unknown as Harness;
  const notified: (string | null)[] = [];

  const transport = new SfuTransport('http://test');
  transport.onAudioTrack = (track) => notified.push((track as unknown as FakeTrack | null)?.id ?? null);

  const internals = transport as unknown as {
    pc: unknown;
    mySessionId: string;
    channelOpen: boolean;
    apiPost: (path: string, body: unknown) => Promise<Record<string, unknown>>;
    reportAudioTrack: (track: unknown) => void;
  };
  internals.pc = {
    getReceivers: () => h.receivers.map((track) => ({ track })),
    setRemoteDescription: () => {
      // 実際のブラウザは SDP 適用中に ontrack を発火させる
      if (h.ontrackTrack) internals.reportAudioTrack(h.ontrackTrack);
      return Promise.resolve();
    },
    createAnswer: () => Promise.resolve({ type: 'answer', sdp: 'a' }),
    setLocalDescription: () => Promise.resolve(),
  };
  internals.mySessionId = 'viewer';
  internals.channelOpen = true;
  internals.apiPost = (path: string) =>
    Promise.resolve(
      path === '/api/sfu/tracks/new' && h.renegotiate
        ? { requiresImmediateRenegotiation: true, sessionDescription: { type: 'offer', sdp: 'o' } }
        : {},
    );

  h.transport = transport;
  h.notified = notified;
  return h;
}

/** setAudioPublisher は内部の直列キューに積むため、消化を待つ */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

describe('マイクの入れ直しと音声トラックの通知', () => {
  let h: Harness;
  beforeEach(() => {
    h = setup();
  });

  it('古いトラックが残っていても、新しい方を通知する', async () => {
    const first = makeTrack('first');
    h.receivers = [first];
    h.ontrackTrack = first;
    h.transport.setAudioPublisher({ sessionId: 'mic-1', trackName: 'mic' });
    await settle();

    // マイクOFF: 配信者のセッションが閉じ、トラックは終了する
    h.transport.setAudioPublisher(null);
    await settle();
    first.readyState = 'ended';

    // マイクON: 新しいセッションのトラックが増える(古いものは残ったまま)
    const second = makeTrack('second');
    h.receivers = [first, second];
    h.ontrackTrack = second;
    h.transport.setAudioPublisher({ sessionId: 'mic-2', trackName: 'mic' });
    await settle();

    // 先頭(死んだトラック)を拾うと 'first' になり、無音になる
    expect(h.notified).toEqual(['first', null, 'second']);
  });

  it('同じ配信元の入れ直しでは購読をやり直さない(トランシーバが増えないこと)', async () => {
    const track = makeTrack('mic');
    h.receivers = [track];
    h.ontrackTrack = track;

    let subscribeCount = 0;
    const internals = h.transport as unknown as {
      apiPost: (path: string, body: unknown) => Promise<Record<string, unknown>>;
    };
    const inner = internals.apiPost.bind(h.transport);
    internals.apiPost = (path, body) => {
      if (path === '/api/sfu/tracks/new') subscribeCount += 1;
      return inner(path, body);
    };

    h.transport.setAudioPublisher({ sessionId: 'mic-session', trackName: 'mic' });
    await settle();

    // 配信者はセッションを作り直さないので、入れ直しても sessionId は同じ
    for (let i = 0; i < 3; i += 1) {
      h.transport.setAudioPublisher(null);
      await settle();
      h.transport.setAudioPublisher({ sessionId: 'mic-session', trackName: 'mic' });
      await settle();
    }

    // 購読は最初の1回だけ。以降は通知だけ
    expect(subscribeCount).toBe(1);
    expect(h.notified).toEqual(['mic', null, 'mic', null, 'mic', null, 'mic']);
  });

  it('再ネゴシエーションが起きない回でも、生きているトラックを通知する', async () => {
    const only = makeTrack('reused');
    h.receivers = [only];
    h.ontrackTrack = only;
    h.transport.setAudioPublisher({ sessionId: 'mic-1', trackName: 'mic' });
    await settle();

    h.transport.setAudioPublisher(null);
    await settle();

    // SFUがトランシーバを使い回すと再ネゴシエーションが起きず ontrack も発火しない
    h.renegotiate = false;
    h.ontrackTrack = null;
    h.transport.setAudioPublisher({ sessionId: 'mic-2', trackName: 'mic' });
    await settle();

    // 停止時に記録を消しているので、同一オブジェクトでも改めて通知される
    expect(h.notified).toEqual(['reused', null, 'reused']);
  });
});
