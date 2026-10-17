/**
 * @vitest-environment node
 *
 * The hub's end of a computer's relay connection, driven against the REAL
 * computer end (`RelayDialer`) over an in-memory socket pair: both ends prove
 * themselves, requests and streams round-trip sealed, heartbeats keep it
 * alive, and anything wrong closes it with every pending call ended cleanly.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SESSION_RELAY_FEATURES,
  SESSION_RELAY_IDLE_CLOSE_MS,
  SESSION_RELAY_MAX_INFLIGHT_REQUESTS,
  SESSION_RELAY_MAX_OPEN_STREAMS,
  type RelayComputerFrame,
  type RelayWebFrame,
} from '@dorkos/shared/session-relay';

vi.mock('../../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { pinnableKey } from '../../session-relay/channel.js';
import {
  RelayDialer,
  type RelayRequestServer,
  type RelaySocket,
} from '../../session-relay/relay-dialer.js';
import type { RelayPin } from '../../session-relay/pin-store.js';
import {
  HUB_RELAY_HANDSHAKE_TIMEOUT_MS,
  HUB_RELAY_SILENCE_TIMEOUT_MS,
  HubComputerConnection,
  RELAY_BAD_ANSWER,
  RELAY_COMPUTER_OFFLINE,
  RELAY_HUB_BUSY,
  RELAY_TIMED_OUT,
  type HubRelaySocket,
  type RelayStreamFrame,
} from '../computer-connection.js';
import {
  computerConnection,
  forgetConnection,
  notePendingConnection,
  promoteConnection,
} from '../hub-relay-registry.js';

const ORIGIN = 'https://dorian.hub.example.test';
const LATER = '2099-01-01T00:00:00.000Z';
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
/** A chat the fake computer refuses to stream, with an `error` as the real one does. */
const REFUSED_SESSION = '00000000-0000-4000-8000-000000000000';

/** Frames in flight, delivered only when the test pumps, as a network would. */
class Wire {
  readonly queue: (() => void)[] = [];
  /** Drop what the computer sends, as a half-open connection does. */
  computerMuted = false;
  readonly computer = new End(this, 'computer');
  readonly hub = new End(this, 'hub');
  pump(): void {
    while (this.queue.length > 0) this.queue.shift()!();
  }
}

/** One end of the {@link Wire}: a socket to whichever side holds it. */
class End implements RelaySocket, HubRelaySocket {
  bufferedAmount = 0;
  closed = false;
  readonly sent: string[] = [];
  private readonly listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  constructor(
    private readonly wire: Wire,
    private readonly side: 'computer' | 'hub'
  ) {}
  private get peer(): End {
    return this.side === 'computer' ? this.wire.hub : this.wire.computer;
  }
  send(text: string): void {
    if (this.closed) return;
    this.sent.push(text);
    if (this.side === 'computer' && this.wire.computerMuted) return;
    this.wire.queue.push(() => this.peer.fire('message', text, false));
  }
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.fire('close');
    this.wire.queue.push(() => this.peer.close());
  }
  on = ((event: string, listener: (...args: never[]) => void): void => {
    const stored = listener as (...args: unknown[]) => void;
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), stored]);
  }) as RelaySocket['on'] & HubRelaySocket['on'];
  fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) listener(...args);
  }
}

/** A computer's request server that answers a few requests and holds the rest. */
function fakeServer(features: readonly string[]) {
  const streams = new Map<string, (frame: RelayComputerFrame) => void>();
  const closedStreams: string[] = [];
  const handled: RelayWebFrame[] = [];
  const server: RelayRequestServer = {
    features: () => features,
    handle(frame: RelayWebFrame, emit) {
      handled.push(frame);
      if (frame.type === 'stream.close') closedStreams.push(frame.streamId);
      if (frame.type !== 'request') return;
      const { id, request } = frame;
      if (request.op === 'chats.list') emit({ type: 'result', id, ok: true, body: { chats: [] } });
      if (request.op === 'session.send') emit({ type: 'result', id, ok: true, body: { nope: 1 } });
      if (request.op === 'session.interrupt') {
        emit({
          type: 'error',
          id,
          ok: false,
          error: { status: 404, code: 'not_found', message: 'No such chat on this computer.' },
        });
      }
      if (request.op === 'session.stream' && request.sessionId === REFUSED_SESSION) {
        emit({
          type: 'error',
          id,
          ok: false,
          error: { status: 400, code: 'invalid', message: 'That stream is already open.' },
        });
      } else if (request.op === 'session.stream') streams.set(request.streamId, emit);
      // `interaction.challenge` is never answered: it stands for a slow computer.
    },
    closeAll: vi.fn(),
    endStream: () => false,
  };
  return { server, streams, closedStreams, handled };
}

interface Options {
  /** The key the hub pinned for this computer; defaults to the computer's own. */
  pinnedKey?: string;
  hubVersions?: { min: number; max: number };
  features?: readonly string[];
  /** Use the live registry as the connection's open and close hooks. */
  registry?: boolean;
}

function setup(options: Options = {}) {
  const hubKey = generateKeyPairSync('ed25519').privateKey;
  const computerKey: KeyObject = generateKeyPairSync('ed25519').privateKey;
  const pin: RelayPin = {
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
  const fake = fakeServer(options.features ?? SESSION_RELAY_FEATURES);
  const onOpen = vi.fn();
  const onClose = vi.fn();
  const wires: Wire[] = [];
  const hubs: HubComputerConnection[] = [];

  /** A fresh dialer, as a computer process has one; each dial gets its own wire. */
  const newDialer = () =>
    new RelayDialer({
      readPin: () => pin,
      ownerExists: () => true,
      computerKey: () => computerKey,
      appVersion: '0.118.0',
      server: fake.server,
      connect: () => {
        const wire = new Wire();
        wires.push(wire);
        const hub = new HubComputerConnection({
          socket: wire.hub,
          computer: {
            computerId: 'computer-1',
            computerKey: options.pinnedKey ?? pinnableKey(computerKey),
          },
          signer: { sign: (data) => sign(null, data, hubKey), origin: ORIGIN },
          onOpen: options.registry ? promoteConnection : onOpen,
          onClose: options.registry ? forgetConnection : onClose,
          requestTimeoutMs: 5_000,
          ...(options.hubVersions ? { versions: options.hubVersions } : {}),
        });
        if (options.registry) notePendingConnection(hub);
        hubs.push(hub);
        return wire.computer;
      },
    });
  const dialer = newDialer();

  /** Dial and run the handshake to the end. */
  function connect(using: RelayDialer = dialer) {
    using.onViewerOpen(LATER);
    const wire = wires.at(-1)!;
    wire.computer.fire('open');
    wire.pump();
    return { wire, hub: hubs.at(-1)! };
  }

  /** Let time pass in short steps, delivering what each step sent. */
  function pass(ms: number) {
    for (let left = ms; left > 0; left -= 5_000) {
      vi.advanceTimersByTime(Math.min(5_000, left));
      for (const wire of wires) wire.pump();
    }
  }

  return { dialer, newDialer, connect, pass, onOpen, onClose, fake, wires };
}

describe('HubComputerConnection', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('completes the handshake with the real computer end', () => {
    const h = setup();
    const { hub } = h.connect();
    expect(hub.connected).toBe(true);
    expect(h.dialer.connected).toBe(true);
    expect(h.onOpen).toHaveBeenCalledWith(hub);
    expect(hub.features).toEqual(SESSION_RELAY_FEATURES);
  });

  it('round-trips a request sealed both ways, and checks the answer', async () => {
    const h = setup();
    const { hub, wire } = h.connect();
    const listed = hub.request({ op: 'chats.list', agentId: AGENT });
    const refused = hub.request({ op: 'session.interrupt', sessionId: SESSION });
    const garbled = hub.request({ op: 'session.send', sessionId: SESSION, content: 'hi' });
    wire.pump();
    await expect(listed).resolves.toEqual({ ok: true, body: { chats: [] } });
    await expect(refused).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
    await expect(garbled).resolves.toEqual({ ok: false, error: RELAY_BAD_ANSWER });
    // Nothing crossed the wire in the clear after the handshake.
    for (const text of wire.hub.sent.slice(1)) expect(JSON.parse(text).type).toBe('sealed');
    for (const text of wire.computer.sent.slice(1)) expect(JSON.parse(text).type).toBe('sealed');
  });

  it('names the browser to a computer that reads it, and never to one that does not', async () => {
    const device = { id: 'browser-id-0001', label: 'Safari on iPhone' };
    const named = (h: ReturnType<typeof setup>) =>
      h.fake.handled.map((frame) => (frame.type === 'request' ? frame.device : null));

    const current = setup();
    const { hub, wire } = current.connect();
    const listed = hub.request({ op: 'chats.list', agentId: AGENT }, device);
    hub.openStream(SESSION, undefined, () => undefined, vi.fn(), device);
    wire.pump();
    await expect(listed).resolves.toMatchObject({ ok: true });
    expect(named(current)).toEqual([device, device]);

    // An older computer advertises no `request.device`; its strict frames would refuse it.
    const older = setup({ features: ['chats.list', 'session.stream'] });
    const old = older.connect();
    const oldListed = old.hub.request({ op: 'chats.list', agentId: AGENT }, device);
    old.hub.openStream(SESSION, undefined, () => undefined, vi.fn(), device);
    old.wire.pump();
    await expect(oldListed).resolves.toMatchObject({ ok: true });
    expect(named(older)).toEqual([undefined, undefined]);
    expect(old.hub.connected).toBe(true);
  });

  it('streams frames until the computer ends the stream', () => {
    const h = setup();
    const { hub, wire } = h.connect();
    const frames: RelayStreamFrame[] = [];
    const onEnd = vi.fn();
    hub.openStream(SESSION, undefined, (frame) => frames.push(frame), onEnd);
    wire.pump();
    const [streamId, emit] = [...h.fake.streams.entries()][0]!;
    emit({ type: 'stream.frame', streamId, frame: { event: 'text_delta', data: 'hello' } });
    emit({ type: 'stream.end', streamId });
    wire.pump();
    expect(frames).toEqual([{ event: 'text_delta', data: 'hello' }]);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(undefined);
  });

  it('ends a stream the computer refused with an error, and frees its slot', async () => {
    const h = setup();
    const { hub, wire } = h.connect();
    for (let i = 0; i < SESSION_RELAY_MAX_OPEN_STREAMS - 1; i++) {
      hub.openStream(SESSION, undefined, vi.fn(), vi.fn());
    }
    const onEnd = vi.fn();
    hub.openStream(REFUSED_SESSION, undefined, vi.fn(), onEnd);
    wire.pump();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ code: 'invalid' }));
    // The refused stream no longer counts against the cap.
    const next = vi.fn();
    hub.openStream(SESSION, undefined, vi.fn(), next);
    await Promise.resolve();
    expect(next).not.toHaveBeenCalled();
  });

  it('closes a stream from the hub side without calling its end', () => {
    const h = setup();
    const { hub, wire } = h.connect();
    const onEnd = vi.fn();
    const close = hub.openStream(SESSION, undefined, vi.fn(), onEnd);
    wire.pump();
    close();
    wire.pump();
    expect(h.fake.closedStreams).toHaveLength(1);
    hub.close();
    expect(onEnd).not.toHaveBeenCalled();
  });

  it('keeps both ends alive with heartbeats, and lets the computer idle out at 0 viewers', () => {
    const h = setup();
    const { hub } = h.connect();
    hub.setViewers(1);
    h.pass(SESSION_RELAY_IDLE_CLOSE_MS * 2);
    expect(hub.connected).toBe(true);
    expect(h.dialer.connected).toBe(true);

    hub.setViewers(0);
    h.pass(SESSION_RELAY_IDLE_CLOSE_MS + 5_000);
    expect(h.dialer.connected).toBe(false);
    expect(hub.connected).toBe(false);
    expect(h.onClose).toHaveBeenCalledTimes(1);
  });

  it('hangs up on a silent computer and ends every pending call', async () => {
    const h = setup();
    const { hub, wire } = h.connect();
    hub.setViewers(1);
    const onEnd = vi.fn();
    hub.openStream(SESSION, undefined, vi.fn(), onEnd);
    wire.computerMuted = true;
    const slow = hub.request({
      op: 'interaction.challenge',
      sessionId: SESSION,
      toolCallId: 't1',
      decision: 'approve',
    });
    h.pass(HUB_RELAY_SILENCE_TIMEOUT_MS + 5_000);
    expect(hub.connected).toBe(false);
    expect(wire.hub.closed).toBe(true);
    // The request timed out first; the stream ended with the connection.
    await expect(slow).resolves.toEqual({ ok: false, error: RELAY_TIMED_OUT });
    expect(onEnd).toHaveBeenCalledWith(RELAY_COMPUTER_OFFLINE);
  });

  it('ends pending requests when the connection closes', async () => {
    const h = setup();
    const { hub, wire } = h.connect();
    const slow = hub.request({
      op: 'interaction.challenge',
      sessionId: SESSION,
      toolCallId: 't1',
      decision: 'deny',
    });
    wire.pump();
    wire.computer.close();
    wire.pump();
    await expect(slow).resolves.toEqual({ ok: false, error: RELAY_COMPUTER_OFFLINE });
    await expect(hub.request({ op: 'chats.list', agentId: AGENT })).resolves.toEqual({
      ok: false,
      error: RELAY_COMPUTER_OFFLINE,
    });
  });

  it('refuses a computer whose finish is not signed by the key it pinned', () => {
    const forged = pinnableKey(generateKeyPairSync('ed25519').privateKey);
    const h = setup({ pinnedKey: forged });
    const { hub, wire } = h.connect();
    expect(hub.connected).toBe(false);
    expect(wire.hub.closed).toBe(true);
    expect(h.onOpen).not.toHaveBeenCalled();
    // Only the welcome went out: nothing sealed, nothing served.
    expect(wire.hub.sent).toHaveLength(1);
  });

  it('sends a signed refusal and hangs up when no version is common', () => {
    const h = setup({ hubVersions: { min: 2, max: 2 } });
    const { hub, wire } = h.connect();
    expect(JSON.parse(wire.hub.sent[0]!).type).toBe('refuse');
    expect(hub.connected).toBe(false);
    expect(wire.hub.closed).toBe(true);
  });

  it('refuses a hello naming another computer', () => {
    const wire = new Wire();
    const hub = new HubComputerConnection({
      socket: wire.hub,
      computer: { computerId: 'computer-2', computerKey: 'A'.repeat(43) },
      signer: { sign: () => Buffer.alloc(64), origin: ORIGIN },
    });
    wire.hub.fire('message', JSON.stringify({ type: 'hello', computerId: 'computer-1' }));
    expect(wire.hub.closed).toBe(true);
    expect(wire.hub.sent).toEqual([]);
    expect(hub.connected).toBe(false);
  });

  it('drops a dial that never finishes the handshake', () => {
    const wire = new Wire();
    new HubComputerConnection({
      socket: wire.hub,
      computer: { computerId: 'computer-1', computerKey: 'A'.repeat(43) },
      signer: { sign: () => Buffer.alloc(64), origin: ORIGIN },
    });
    vi.advanceTimersByTime(HUB_RELAY_HANDSHAKE_TIMEOUT_MS);
    expect(wire.hub.closed).toBe(true);
  });

  it('hangs up on a binary frame, and on a frame that does not open', () => {
    const a = setup();
    const first = a.connect();
    first.wire.hub.fire('message', Buffer.from('{}'), true);
    expect(first.hub.connected).toBe(false);

    const b = setup();
    const second = b.connect();
    second.wire.hub.fire('message', JSON.stringify({ type: 'sealed', seq: 0, box: 'AAAA' }));
    expect(second.hub.connected).toBe(false);
  });

  it('refuses, without sending, what the computer lacks or past the caps', async () => {
    const h = setup({ features: ['chats.list'] });
    const { hub, wire } = h.connect();
    const sentBefore = wire.hub.sent.length;
    await expect(hub.request({ op: 'session.interrupt', sessionId: SESSION })).resolves.toEqual({
      ok: false,
      error: expect.objectContaining({ code: 'needs_update', feature: 'session.interrupt' }),
    });
    const onEnd = vi.fn();
    hub.openStream(SESSION, undefined, vi.fn(), onEnd);
    await Promise.resolve();
    expect(onEnd).toHaveBeenCalledWith(expect.objectContaining({ feature: 'session.stream' }));
    expect(wire.hub.sent).toHaveLength(sentBefore);

    const all = setup();
    const open = all.connect().hub;
    for (let i = 0; i < SESSION_RELAY_MAX_INFLIGHT_REQUESTS; i++) {
      void open.request({
        op: 'interaction.challenge',
        sessionId: SESSION,
        toolCallId: `t${i}`,
        decision: 'approve',
      });
    }
    await expect(open.request({ op: 'chats.list', agentId: AGENT })).resolves.toEqual({
      ok: false,
      error: RELAY_HUB_BUSY,
    });
    for (let i = 0; i < SESSION_RELAY_MAX_OPEN_STREAMS; i++) {
      open.openStream(SESSION, undefined, vi.fn(), vi.fn());
    }
    const busy = vi.fn();
    open.openStream(SESSION, undefined, vi.fn(), busy);
    await Promise.resolve();
    expect(busy).toHaveBeenCalledWith(RELAY_HUB_BUSY);
  });
});

describe('the hub relay registry', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('replaces a live connection with a newly proved one and closes the old', () => {
    const h = setup({ registry: true });
    const first = h.connect();
    expect(computerConnection('computer-1')).toBe(first.hub);

    // The same computer dials again, as after a restart.
    const second = h.connect(h.newDialer());
    expect(computerConnection('computer-1')).toBe(second.hub);
    expect(first.hub.connected).toBe(false);
    expect(first.wire.hub.closed).toBe(true);

    second.hub.close();
    expect(computerConnection('computer-1')).toBeNull();
  });

  it('keeps the live connection when a dial cannot prove itself', () => {
    const live = setup({ registry: true });
    const first = live.connect();
    const forged = setup({
      registry: true,
      pinnedKey: pinnableKey(generateKeyPairSync('ed25519').privateKey),
    });
    forged.connect();
    expect(computerConnection('computer-1')).toBe(first.hub);
    first.hub.close();
  });

  it('lets the real computer finish while a stolen secret loops dials', () => {
    const h = setup({ registry: true });
    // The real computer dials and has sent its hello; its finish is in flight.
    h.dialer.onViewerOpen(LATER);
    const real = h.wires.at(-1)!;
    real.computer.fire('open');
    // Two more unproved dials arrive before it finishes (the cap is three).
    const make = () => {
      const wire = new Wire();
      notePendingConnection(
        new HubComputerConnection({
          socket: wire.hub,
          computer: { computerId: 'computer-1', computerKey: 'A'.repeat(43) },
          signer: { sign: () => Buffer.alloc(64), origin: ORIGIN },
          onClose: forgetConnection,
        })
      );
      return wire;
    };
    make();
    make();
    real.pump();
    expect(real.hub.closed).toBe(false);
    expect(computerConnection('computer-1')).not.toBeNull();
    computerConnection('computer-1')!.close();
  });

  it('holds at most three unproved dials per computer, closing the oldest', () => {
    const make = () => {
      const wire = new Wire();
      const hub = new HubComputerConnection({
        socket: wire.hub,
        computer: { computerId: 'computer-9', computerKey: 'A'.repeat(43) },
        signer: { sign: () => Buffer.alloc(64), origin: ORIGIN },
        onClose: forgetConnection,
      });
      notePendingConnection(hub);
      return wire;
    };
    const wires = [make(), make(), make(), make()];
    expect(wires.map((w) => w.hub.closed)).toEqual([true, false, false, false]);
  });
});
