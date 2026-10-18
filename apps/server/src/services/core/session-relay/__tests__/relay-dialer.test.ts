/**
 * @vitest-environment node
 *
 * The computer's relay connection: dial only the pinned hub, only on a live
 * `viewer_open`, only with an owner; serve nothing before both ends are
 * proved; close on any bad frame and when no viewer is left.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelayComputerFrameSchema,
  RelaySealedFrameSchema,
  SESSION_RELAY_IDLE_CLOSE_MS,
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayComputerFrame,
  type RelayWebFrame,
} from '@dorkos/shared/session-relay';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { answerHello, pinnableKey, type RelayChannel } from '../channel.js';
import {
  RELAY_HANDSHAKE_TIMEOUT_MS,
  RELAY_REDIAL_BACKOFF_MS,
  RELAY_SEND_BUFFER_MAX_BYTES,
  RELAY_SILENCE_TIMEOUT_MS,
  RelayDialer,
  type RelayRequestServer,
  type RelaySocket,
} from '../relay-dialer.js';
import type { RelayPin } from '../pin-store.js';

const ORIGIN = 'https://dorian.hub.example.test';
const LATER = '2099-01-01T00:00:00.000Z';

/** A socket whose other end the test plays. */
class FakeSocket implements RelaySocket {
  sent: string[] = [];
  closed = false;
  bufferedAmount = 0;
  private listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor(
    readonly url: string,
    readonly headers: Record<string, string>
  ) {}
  send(text: string): void {
    this.sent.push(text);
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
  }
  on = ((event: string, listener: (...args: never[]) => void): void => {
    const stored = listener as (...args: unknown[]) => void;
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), stored]);
  }) as RelaySocket['on'];
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

function keys() {
  const hub = generateKeyPairSync('ed25519').privateKey;
  const computer = generateKeyPairSync('ed25519').privateKey;
  return { hub, computer };
}

function pinFor(hubKey: KeyObject): RelayPin {
  return {
    v: 2,
    computerId: 'computer-1',
    hubOrigin: ORIGIN,
    hubKey: pinnableKey(hubKey),
    relaySecret: randomBytes(32).toString('base64url'),
    pinnedAt: '2026-10-16T21:00:00.000Z',
    computerName: 'Studio Mac',
    level: 'chat',
    paused: false,
  };
}

function setup(
  overrides: {
    pin?: RelayPin | null;
    owner?: boolean;
    hubSigner?: KeyObject;
    computerKey?: () => KeyObject;
  } = {}
) {
  const { hub, computer } = keys();
  let pin = overrides.pin === undefined ? pinFor(hub) : overrides.pin;
  const sockets: FakeSocket[] = [];
  const handled: RelayWebFrame[] = [];
  const ended: { streamId: string; code: string }[] = [];
  let reply: ((frame: RelayComputerFrame) => void) | null = null;
  const server: RelayRequestServer = {
    features: () => ['session.stream', 'not-a-feature'],
    handle: (frame, emit) => {
      handled.push(frame);
      reply = emit;
    },
    closeAll: vi.fn(),
    endStream: (streamId, error) => {
      ended.push({ streamId, code: error.code });
      return false;
    },
  };
  const dialer = new RelayDialer({
    readPin: () => pin,
    ownerExists: () => overrides.owner ?? true,
    computerKey: overrides.computerKey ?? (() => computer),
    appVersion: '0.118.0',
    server,
    connect: (url, headers) => {
      const socket = new FakeSocket(url, headers);
      sockets.push(socket);
      return socket;
    },
  });

  /** Play the hub: answer the hello the computer sent, check its finish. */
  function hubAnswers(
    signer: KeyObject = overrides.hubSigner ?? hub,
    origin: string = ORIGIN
  ): RelayChannel | null {
    const socket = sockets.at(-1)!;
    socket.fire('open');
    const helloText = socket.sent[0]!;
    const answered = answerHello(helloText, 'computer-1', {
      sign: (data) => sign(null, data, signer),
      origin,
    });
    if (!answered.ok) throw new Error('hub refused the hello');
    socket.fire('message', JSON.stringify(answered.answer));
    if (!answered.pending || socket.sent.length < 2) return null;
    const finish = RelaySealedFrameSchema.parse(JSON.parse(socket.sent[1]!));
    return answered.pending.acceptFinish(finish, pinnableKey(computer));
  }

  /** Send one inner frame from the hub, sealed. */
  function hubSends(channel: RelayChannel, frame: RelayWebFrame) {
    sockets.at(-1)!.fire('message', encodeRelayFrame(channel.seal(encodeRelayFrame(frame)!)!));
  }

  /** The last frame the computer sent, opened. */
  function lastFromComputer(channel: RelayChannel): RelayComputerFrame | null {
    const sealed = RelaySealedFrameSchema.parse(JSON.parse(sockets.at(-1)!.sent.at(-1)!));
    const text = channel.open(sealed);
    return text === null ? null : decodeRelayFrame(text, RelayComputerFrameSchema);
  }

  return {
    dialer,
    sockets,
    handled,
    ended,
    server,
    hubAnswers,
    hubSends,
    lastFromComputer,
    reply: () => reply,
    pin,
    removePin: () => {
      pin = null;
    },
  };
}

describe('RelayDialer', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('stays off with no pin, or once the command has expired', () => {
    expect(setup({ pin: null }).dialer.onViewerOpen(LATER)).toBe('ignored');
    const { dialer, sockets } = setup();
    expect(dialer.onViewerOpen('2000-01-01T00:00:00.000Z')).toBe('ignored');
    expect(sockets).toHaveLength(0);
  });

  it('refuses to dial a computer nobody can sign in to', () => {
    const { dialer, sockets } = setup({ owner: false });
    expect(dialer.onViewerOpen(LATER)).toBe('refused:no-owner');
    expect(sockets).toHaveLength(0);
  });

  it('dials only the pinned origin, over wss, with the pinned secret, and only once', () => {
    const { dialer, sockets, pin } = setup();
    expect(dialer.onViewerOpen(LATER)).toBe('applied');
    expect(dialer.onViewerOpen(LATER)).toBe('applied');
    expect(sockets).toHaveLength(1);
    expect(sockets[0]!.url).toBe('wss://dorian.hub.example.test/api/relay/computer');
    expect(sockets[0]!.headers).toEqual({ Authorization: `Bearer ${pin!.relaySecret}` });
  });

  it('dials now with no command, under the same checks, as an agent computer does (DOR-2940)', () => {
    expect(setup({ pin: null }).dialer.dialNow()).toBe('ignored');
    expect(setup({ owner: false }).dialer.dialNow()).toBe('refused:no-owner');
    const { dialer, sockets } = setup();
    expect(dialer.dialNow()).toBe('applied');
    expect(dialer.dialNow()).toBe('applied');
    expect(sockets).toHaveLength(1);
  });

  it('tries a moved hub at its new origin, and says so only once the pinned key proves', () => {
    const MOVED = 'https://moved.hub.example.test';
    const h = setup();
    const onProved = vi.fn();
    expect(h.dialer.dialAt(MOVED, onProved)).toBe('applied');
    expect(h.sockets[0]!.url).toBe('wss://moved.hub.example.test/api/relay/computer');
    expect(onProved).not.toHaveBeenCalled();
    expect(h.hubAnswers(undefined, MOVED)).not.toBeNull();
    expect(onProved).toHaveBeenCalledTimes(1);
  });

  it('never says a moved hub proved itself when it signs with another key', () => {
    const MOVED = 'https://moved.hub.example.test';
    const h = setup();
    const onProved = vi.fn();
    h.dialer.dialAt(MOVED, onProved);
    expect(h.hubAnswers(generateKeyPairSync('ed25519').privateKey, MOVED)).toBeNull();
    expect(onProved).not.toHaveBeenCalled();
    expect(h.dialer.connected).toBe(false);
  });

  it('advertises only the features the protocol knows', () => {
    const { dialer, sockets } = setup();
    dialer.onViewerOpen(LATER);
    sockets[0]!.fire('open');
    expect(JSON.parse(sockets[0]!.sent[0]!).features).toEqual(['session.stream']);
  });

  it('connects to its own hub, proves itself, and serves requests sealed both ways', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers();
    expect(channel).not.toBeNull();
    expect(h.dialer.connected).toBe(true);

    const request: RelayWebFrame = {
      type: 'request',
      id: 'r1',
      request: { op: 'session.interrupt', sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c' },
    };
    h.hubSends(channel!, request);
    expect(h.handled).toEqual([request]);

    h.reply()!({ type: 'result', id: 'r1', ok: true, body: { ok: true } });
    expect(h.lastFromComputer(channel!)).toEqual({
      type: 'result',
      id: 'r1',
      ok: true,
      body: { ok: true },
    });
  });

  it('ends a stream on both sides when one of its frames is too large to send', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.hubSends(channel, {
      type: 'request',
      id: 'r1',
      request: { op: 'session.interrupt', sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c' },
    });
    h.reply()!({
      type: 'stream.frame',
      streamId: 's1',
      frame: { event: 'text_delta', data: 'x'.repeat(2_000_000) },
    });
    expect(h.lastFromComputer(channel)).toMatchObject({ type: 'stream.end', streamId: 's1' });
    expect(h.ended).toEqual([{ streamId: 's1', code: 'internal' }]);
  });

  it('ends a stream, rather than buffer without bound, when the hub stops reading', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.hubSends(channel, {
      type: 'request',
      id: 'r1',
      request: { op: 'session.interrupt', sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c' },
    });
    h.sockets[0]!.bufferedAmount = RELAY_SEND_BUFFER_MAX_BYTES + 1;
    h.reply()!({ type: 'stream.frame', streamId: 's1', frame: { event: 'text_delta' } });
    expect(h.lastFromComputer(channel)).toMatchObject({
      type: 'stream.end',
      streamId: 's1',
      error: { code: 'rate_limited' },
    });
    expect(h.ended).toEqual([{ streamId: 's1', code: 'rate_limited' }]);
  });

  it('serves nothing to a hub that does not hold the pinned key, and hangs up', () => {
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const h = setup({ hubSigner: impostor });
    h.dialer.onViewerOpen(LATER);
    expect(h.hubAnswers()).toBeNull();
    expect(h.dialer.connected).toBe(false);
    expect(h.sockets[0]!.closed).toBe(true);
    // Only the hello went out: no finish, nothing served.
    expect(h.sockets[0]!.sent).toHaveLength(1);
  });

  it('hangs up on a frame that does not open, and stops every stream', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    h.hubAnswers();
    h.sockets[0]!.fire('message', JSON.stringify({ type: 'sealed', seq: 0, box: 'AAAA' }));
    expect(h.dialer.connected).toBe(false);
    expect(h.sockets[0]!.closed).toBe(true);
    expect(h.server.closeAll).toHaveBeenCalled();
  });

  it('never acts on a plain, unsealed request after the handshake', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    h.hubAnswers();
    h.sockets[0]!.fire(
      'message',
      JSON.stringify({
        type: 'request',
        id: 'r1',
        request: { op: 'chats.list', agentId: '01KJXYKJYW4N8QGQ5W4GB6YM9J' },
      })
    );
    expect(h.handled).toEqual([]);
    expect(h.dialer.connected).toBe(false);
  });

  it('answers a heartbeat', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.hubSends(channel, { type: 'heartbeat' });
    expect(h.lastFromComputer(channel)).toEqual({ type: 'heartbeat' });
  });

  it('closes a few minutes after the last viewer leaves, and not while one is there', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    /** Let time pass while the hub keeps its heartbeat, as a live hub does. */
    const pass = (ms: number) => {
      for (let left = ms; left > 0; left -= 30_000) {
        vi.advanceTimersByTime(Math.min(30_000, left));
        if (h.dialer.connected) h.hubSends(channel, { type: 'heartbeat' });
      }
    };
    h.hubSends(channel, { type: 'viewers', count: 1 });
    pass(SESSION_RELAY_IDLE_CLOSE_MS * 2);
    expect(h.dialer.connected).toBe(true);

    h.hubSends(channel, { type: 'viewers', count: 0 });
    pass(SESSION_RELAY_IDLE_CLOSE_MS - 30_000);
    expect(h.dialer.connected).toBe(true);
    pass(30_000);
    expect(h.dialer.connected).toBe(false);
    expect(h.sockets[0]!.closed).toBe(true);
  });

  it('closes after a few minutes when the hub never reports viewers', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    h.hubAnswers();
    vi.advanceTimersByTime(SESSION_RELAY_IDLE_CLOSE_MS);
    expect(h.dialer.connected).toBe(false);
  });

  it('gives up on a hub that never answers the hello', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    h.sockets[0]!.fire('open');
    vi.advanceTimersByTime(RELAY_HANDSHAKE_TIMEOUT_MS);
    expect(h.sockets[0]!.closed).toBe(true);
    // And dials afresh on the next command.
    expect(h.dialer.onViewerOpen(LATER)).toBe('applied');
    expect(h.sockets).toHaveLength(2);
  });

  it('reads the frames ws actually delivers, as Buffers', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const socket = h.sockets[0]!;
    socket.fire('open');
    const answered = answerHello(socket.sent[0]!, 'computer-1', {
      sign: (data) => sign(null, data, keys().hub),
      origin: ORIGIN,
    });
    if (!answered.ok) throw new Error('unexpected');
    // A Buffer from an impostor still fails verification, not parsing.
    socket.fire('message', Buffer.from(JSON.stringify(answered.answer)), false);
    expect(h.dialer.connected).toBe(false);

    const g = setup();
    g.dialer.onViewerOpen(LATER);
    const channel = g.hubAnswers()!;
    const sealed = encodeRelayFrame(channel.seal(encodeRelayFrame({ type: 'heartbeat' })!)!)!;
    g.sockets[0]!.fire('message', Buffer.from(sealed), false);
    expect(g.lastFromComputer(channel)).toEqual({ type: 'heartbeat' });
  });

  it('hangs up on a binary frame', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    const sealed = encodeRelayFrame(channel.seal(encodeRelayFrame({ type: 'heartbeat' })!)!)!;
    h.sockets[0]!.fire('message', Buffer.from(sealed), true);
    expect(h.dialer.connected).toBe(false);
  });

  it('notices a hub that went silent, so the next viewer_open dials afresh', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.hubSends(channel, { type: 'viewers', count: 2 });
    vi.advanceTimersByTime(RELAY_SILENCE_TIMEOUT_MS - 1);
    expect(h.dialer.connected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(h.dialer.connected).toBe(false);
    expect(h.dialer.onViewerOpen(LATER)).toBe('applied');
    expect(h.sockets).toHaveLength(2);
  });

  it('stays connected while the hub keeps talking', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.hubSends(channel, { type: 'viewers', count: 1 });
    for (let i = 0; i < 5; i++) {
      vi.advanceTimersByTime(RELAY_SILENCE_TIMEOUT_MS / 2);
      h.hubSends(channel, { type: 'heartbeat' });
    }
    expect(h.dialer.connected).toBe(true);
  });

  it('closes when the pin is gone, checked on the next viewer report', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.removePin();
    h.hubSends(channel, { type: 'viewers', count: 1 });
    expect(h.dialer.connected).toBe(false);
    expect(h.server.closeAll).toHaveBeenCalled();
  });

  it('serves no request once the pin is gone or paused, checked on every frame', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    const channel = h.hubAnswers()!;
    h.removePin();
    h.hubSends(channel, {
      type: 'request',
      id: 'r1',
      request: { op: 'session.interrupt', sessionId: '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c' },
    });
    expect(h.handled).toEqual([]);
    expect(h.dialer.connected).toBe(false);
  });

  it('answers failed, with no socket, when its own key cannot be read', () => {
    const h = setup({
      computerKey: () => {
        throw new Error('EACCES');
      },
    });
    expect(h.dialer.onViewerOpen(LATER)).toBe('failed');
    expect(h.sockets).toHaveLength(0);
  });

  it('waits a little before dialing again after a failed handshake', () => {
    const impostor = generateKeyPairSync('ed25519').privateKey;
    const h = setup({ hubSigner: impostor });
    h.dialer.onViewerOpen(LATER);
    h.hubAnswers();
    expect(h.dialer.onViewerOpen(LATER)).toBe('ignored');
    vi.advanceTimersByTime(RELAY_REDIAL_BACKOFF_MS);
    expect(h.dialer.onViewerOpen(LATER)).toBe('applied');
  });

  it('stops every stream when the hub closes, and survives an error then a close', () => {
    const h = setup();
    h.dialer.onViewerOpen(LATER);
    h.hubAnswers();
    h.sockets[0]!.fire('error', new Error('ECONNRESET'));
    h.sockets[0]!.fire('close');
    expect(h.dialer.connected).toBe(false);
    expect(h.server.closeAll).toHaveBeenCalledTimes(1);
  });

  it('treats an expiry it cannot read as passed', () => {
    const { dialer, sockets } = setup();
    expect(dialer.onViewerOpen('not a date')).toBe('ignored');
    expect(sockets).toHaveLength(0);
  });
});
