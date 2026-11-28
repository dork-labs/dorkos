/**
 * @vitest-environment node
 *
 * The hello both ways (spec `space-computer-contract` §4.1, W1, DOR-5164),
 * driven between the REAL hub end (`HubComputerConnection`) and either the
 * REAL computer end (`RelayDialer`) or a raw computer that runs the real
 * handshake and then seals whatever the test hands it. Proofs H2 and H3 of
 * §15.1, and Security's terms on the refusals and the agreed set. H1 runs both
 * ways in the wire conformance suite (`wire-conformance.test.ts`).
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelaySealedFrameSchema,
  SESSION_RELAY_FEATURES,
  decodeRelayFrame,
  encodeRelayFrame,
  type RelayWebFrame,
} from '@dorkos/shared/session-relay';
import type { RelayCall } from '@dorkos/shared/session-relay-agent-computer';
import { logger } from '../../../../lib/logger.js';
import {
  finishComputerHandshake,
  pinnableKey,
  startComputerHandshake,
  type RelayChannel,
} from '../../session-relay/channel.js';
import { RelayDialer, type RelayRequestServer } from '../../session-relay/relay-dialer.js';
import type { RelayPin } from '../../session-relay/pin-store.js';
import {
  HOME_MAX_REFUSALS,
  HOME_REFUSAL_WINDOW_MS,
  type HomeCallServer,
} from '../agent-computer-hello.js';
import {
  HubComputerConnection,
  type HubComputerConnectionOptions,
} from '../computer-connection.js';
import { Wire } from '@dorkos/test-utils/relay-socket-pair';

const ORIGIN = 'https://home.example.test';
const LATER = '2099-01-01T00:00:00.000Z';
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const SESSION = '3f1c2b7a-8d4e-4f6a-9b0c-1d2e3f4a5b6c';
const LIST: RelayCall = { op: 'tools.list', agentId: AGENT, sessionId: SESSION };
const CALL: RelayCall = {
  op: 'tools.call',
  agentId: AGENT,
  sessionId: SESSION,
  tool: 'mesh_list',
  input: {},
};
const CHAT_ONLY = [...SESSION_RELAY_FEATURES];

const hubKey = generateKeyPairSync('ed25519').privateKey;
const computerKey: KeyObject = generateKeyPairSync('ed25519').privateKey;

type HomeOptions = Omit<HubComputerConnectionOptions, 'socket' | 'computer' | 'signer'>;

/** The home end over a fresh wire. */
function home(wire: Wire, options: HomeOptions = {}) {
  return new HubComputerConnection({
    socket: wire.hub,
    computer: { computerId: 'computer-1', computerKey: pinnableKey(computerKey) },
    signer: { sign: (data) => sign(null, data, hubKey), origin: ORIGIN },
    ...options,
  });
}

/** An agent computer's home: its record says so, and the experiment is on. */
const AGENT_HOME: HomeOptions = { role: 'agent-computer', agentComputers: () => true };

/** A home that serves `tools.list` and `computer.status`, answering both. */
function serving(): HomeCallServer & { served: RelayCall[] } {
  const served: RelayCall[] = [];
  return {
    served,
    features: ['tools.list', 'computer.status'],
    serve: async (call) => {
      served.push(call);
      return call.op === 'tools.list' ? { tools: [] } : { ok: true };
    },
  };
}

/** A computer's request server answering `chats.list`, naming `features`. */
function server(features: readonly string[]): RelayRequestServer {
  return {
    features: () => features,
    handle(frame: RelayWebFrame, emit) {
      if (frame.type === 'request' && frame.request.op === 'chats.list') {
        emit({ type: 'result', id: frame.id, ok: true, body: { chats: [] } });
      }
    },
    closeAll: () => undefined,
    endStream: () => false,
  };
}

/** The real computer end, dialed against `home` and run to the end of the handshake. */
function dial(features: readonly string[], options: HomeOptions = {}) {
  const pin: RelayPin = {
    v: 2,
    computerId: 'computer-1',
    hubOrigin: ORIGIN,
    hubKey: pinnableKey(hubKey),
    relaySecret: randomBytes(32).toString('base64url'),
    pinnedAt: '2026-11-27T21:00:00.000Z',
    computerName: 'Build box',
    level: 'chat',
    paused: false,
  };
  const wire = new Wire();
  let hub: HubComputerConnection | null = null;
  const dialer = new RelayDialer({
    readPin: () => pin,
    ownerExists: () => true,
    computerKey: () => computerKey,
    appVersion: '0.143.0',
    server: server(features),
    connect: () => {
      hub = home(wire, options);
      return wire.computer;
    },
  });
  dialer.onViewerOpen(LATER);
  wire.computer.fire('open');
  wire.pump();
  return { wire, dialer, hub: hub! };
}

/** A computer that runs the real handshake, then seals whatever it is handed. */
function rawComputer(features: readonly string[], options: HomeOptions) {
  const wire = new Wire();
  const hub = home(wire, options);
  const handshake = startComputerHandshake('computer-1', features, '0.143.0');
  let channel: RelayChannel | null = null;
  const received: { type: string; [key: string]: unknown }[] = [];
  wire.computer.on('message', (data: unknown) => {
    const text = String(data);
    if (!channel) {
      const finished = finishComputerHandshake(handshake, text, {
        hubOrigin: ORIGIN,
        hubKey: pinnableKey(hubKey),
        computerKey,
      });
      if (!finished.ok) throw new Error('the handshake failed');
      channel = finished.channel;
      wire.computer.send(encodeRelayFrame(finished.finish)!);
      return;
    }
    const inner = channel.open(decodeRelayFrame(text, RelaySealedFrameSchema)!);
    received.push(JSON.parse(inner!));
  });
  wire.computer.send(handshake.helloText);
  wire.pump();
  const send = (frame: unknown) => {
    wire.computer.send(encodeRelayFrame(channel!.seal(JSON.stringify(frame))!)!);
  };
  const results = () => received.filter((frame) => frame.type === 'call.result');
  return { wire, hub, received, send, results };
}

/** Deliver what was sent, letting served calls answer between rounds. */
async function flush(wire: Wire): Promise<void> {
  for (let round = 0; round < 5; round += 1) {
    wire.pump();
    await Promise.resolve();
  }
}

describe('the hello both ways', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('answers a call it cannot read with needs_update, naming no feature and echoing nothing', async () => {
    const computer = rawComputer([...CHAT_ONLY, 'tools.call'], AGENT_HOME);
    computer.send({ type: 'call', id: 'c1', call: { op: 'tools.steal', secret: 'echo-me-not' } });
    await flush(computer.wire);
    const [refusal] = computer.results();
    expect(refusal).toEqual({
      type: 'call.result',
      id: 'c1',
      ok: false,
      error: { status: 501, code: 'needs_update', message: expect.any(String) },
    });
    expect(JSON.stringify(refusal)).not.toMatch(/echo-me-not|tools\.steal/);
    expect(computer.hub.connected).toBe(true);
  });

  it(`closes a connection past ${HOME_MAX_REFUSALS} refusals in a minute, and only then`, async () => {
    const computer = rawComputer([...CHAT_ONLY, 'tools.call'], AGENT_HOME);
    for (let id = 1; id <= HOME_MAX_REFUSALS; id += 1) {
      computer.send({ type: 'call', id: `c${id}`, call: CALL });
    }
    await flush(computer.wire);
    expect(computer.results()).toHaveLength(HOME_MAX_REFUSALS);
    expect(computer.hub.connected).toBe(true);

    // A new window starts the count again.
    vi.advanceTimersByTime(HOME_REFUSAL_WINDOW_MS);
    computer.send({ type: 'heartbeat' });
    for (let id = 1; id <= HOME_MAX_REFUSALS; id += 1) {
      computer.send({ type: 'call', id: `d${id}`, call: CALL });
    }
    await flush(computer.wire);
    expect(computer.hub.connected).toBe(true);

    const warned = vi.spyOn(logger, 'warn');
    computer.send({ type: 'call', id: 'd33', call: CALL });
    await flush(computer.wire);
    expect(computer.hub.connected).toBe(false);
    expect(warned).toHaveBeenCalledWith(
      '[HubRelay] A computer sent too many refused calls; closing'
    );
    warned.mockRestore();
  });

  it('never falls back to a looser schema: an agreed call with one field too many is not served', async () => {
    const calls = serving();
    const computer = rawComputer([...CHAT_ONLY, 'tools.list'], { ...AGENT_HOME, calls });
    expect(computer.hub.agreedFeatures).toEqual(['tools.list']);
    computer.send({ type: 'call', id: 'c1', call: LIST, extra: 1 });
    await flush(computer.wire);
    expect(computer.results()).toEqual([
      {
        type: 'call.result',
        id: 'c1',
        ok: false,
        error: { status: 501, code: 'needs_update', message: expect.any(String) },
      },
    ]);
    expect(calls.served).toEqual([]);
  });

  it('closes on a frame it cannot read that is not a call', async () => {
    const computer = rawComputer([...CHAT_ONLY, 'tools.call'], AGENT_HOME);
    computer.send({ type: 'result', id: 'r1', ok: true, body: {}, extra: 'field' });
    await flush(computer.wire);
    expect(computer.hub.connected).toBe(false);
  });

  it('refuses a features frame from the computer side by closing', async () => {
    const computer = rawComputer([...CHAT_ONLY, 'tools.call'], AGENT_HOME);
    computer.send({ type: 'features', features: ['tools.call'] });
    await flush(computer.wire);
    expect(computer.hub.connected).toBe(false);
  });

  it('agrees nothing the hello did not name, and keeps unknown ids out of the set and the logs', async () => {
    const logged = [
      vi.spyOn(logger, 'info'),
      vi.spyOn(logger, 'warn'),
      vi.spyOn(logger, 'error'),
      vi.spyOn(logger, 'debug'),
    ];
    const calls = serving();
    const computer = rawComputer([...CHAT_ONLY, 'tools.list', 'zz.unknown-feature'], {
      ...AGENT_HOME,
      calls,
    });
    expect(computer.hub.agreedFeatures).toEqual(['tools.list']);
    computer.send({
      type: 'call',
      id: 'c1',
      call: { op: 'computer.status', busy: false, turns: [] },
    });
    await flush(computer.wire);
    expect(computer.results()[0]).toMatchObject({
      ok: false,
      error: { feature: 'computer.status' },
    });
    for (const spy of logged) expect(JSON.stringify(spy.mock.calls)).not.toContain('zz.unknown');
    for (const spy of logged) spy.mockRestore();
  });

  it('refuses, never trims, a hello past the bounds on what it may name', () => {
    for (const features of [
      Array.from({ length: 65 }, (_, i) => `f${i}`),
      ['x'.repeat(65)],
      ['Tools.Call'],
      ['tools call'],
    ]) {
      const computer = rawComputer(features, AGENT_HOME);
      expect(computer.hub.connected, JSON.stringify(features).slice(0, 40)).toBe(false);
      expect(computer.wire.hub.closed).toBe(true);
    }
  });

  it('H2: a computer from before W1 gets no features frame, and the chat operations work', async () => {
    // A chat-only dialer reads with today's strict schema: a features frame would close it.
    const { wire, dialer, hub } = dial(CHAT_ONLY, { ...AGENT_HOME, calls: serving() });
    const listed = hub.request({ op: 'chats.list', agentId: AGENT });
    await flush(wire);
    await expect(listed).resolves.toEqual({ ok: true, body: { chats: [] } });
    expect(hub.agreedFeatures).toEqual([]);
    expect(dialer.connected).toBe(true);
  });

  it('H3: a new computer against a home from before W1 agrees nothing and sends no call', async () => {
    // A `computer` record, or the experiment off, is today's home: a call would close it.
    for (const options of [
      { calls: serving() },
      { role: 'agent-computer', calls: serving() },
    ] as const) {
      const { wire, dialer, hub } = dial([...CHAT_ONLY, 'tools.list'], options);
      expect(dialer.agreedFeatures).toEqual([]);
      const sentBefore = wire.computer.sent.length;
      await expect(dialer.call(LIST)).resolves.toMatchObject({
        ok: false,
        error: { code: 'needs_update', feature: 'tools.list' },
      });
      expect(wire.computer.sent).toHaveLength(sentBefore);
      const listed = hub.request({ op: 'chats.list', agentId: AGENT });
      await flush(wire);
      await expect(listed).resolves.toMatchObject({ ok: true });
      expect(hub.connected && dialer.connected).toBe(true);
    }
  });

  it('keeps today’s rule without both the record and the experiment: a call closes', async () => {
    // A `computer` record with the experiment on (every live connection in
    // W1), and an `agent-computer` record with it off.
    const todays: HomeOptions[] = [
      { agentComputers: () => true, calls: serving() },
      { role: 'agent-computer', agentComputers: () => false, calls: serving() },
    ];
    for (const options of todays) {
      const computer = rawComputer([...CHAT_ONLY, 'tools.list'], options);
      expect(computer.received.map((frame) => frame.type)).toEqual(['viewers']);
      computer.send({ type: 'call', id: 'c1', call: LIST });
      await flush(computer.wire);
      expect(computer.hub.connected).toBe(false);
    }
  });
});
