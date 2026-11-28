/**
 * @vitest-environment node
 *
 * The computer's half of the hello (spec `space-computer-contract` §4.1, W1,
 * DOR-5164): the REAL dialer against a raw home that runs the real handshake
 * and then seals whatever the test hands it. The agreed set is fixed once, by
 * the first sealed frame after `finish`, and never widens past what both
 * signed lists name.
 */
import { generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RelaySealedFrameSchema,
  SESSION_RELAY_FEATURES,
  decodeRelayFrame,
  encodeRelayFrame,
} from '@dorkos/shared/session-relay';
import { Wire } from '../../hub-relay/__tests__/relay-socket-pair.js';
import { answerHello, pinnableKey, type PendingHubChannel, type RelayChannel } from '../channel.js';
import { RelayDialer } from '../relay-dialer.js';
import type { RelayPin } from '../pin-store.js';

const ORIGIN = 'https://home.example.test';
const LATER = '2099-01-01T00:00:00.000Z';
const AGENT = '01KJXYKJYW4N8QGQ5W4GB6YM9J';
const CHAT_ONLY = [...SESSION_RELAY_FEATURES];

const hubKey = generateKeyPairSync('ed25519').privateKey;
const computerKey: KeyObject = generateKeyPairSync('ed25519').privateKey;

/** The real dialer against a home the test drives frame by frame. */
function rawHome(features: readonly string[]) {
  const wire = new Wire();
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
  let pending: PendingHubChannel | null = null;
  let channel: RelayChannel | null = null;
  const received: { type: string; [key: string]: unknown }[] = [];
  wire.hub.on('message', (data: unknown) => {
    const text = String(data);
    if (!pending) {
      const answered = answerHello(text, 'computer-1', {
        sign: (bytes) => sign(null, bytes, hubKey),
        origin: ORIGIN,
      });
      if (!answered.ok || !answered.pending) throw new Error('the hello was refused');
      pending = answered.pending;
      wire.hub.send(encodeRelayFrame(answered.answer)!);
      return;
    }
    const sealed = decodeRelayFrame(text, RelaySealedFrameSchema)!;
    if (!channel) {
      channel = pending.acceptFinish(sealed, pinnableKey(computerKey));
      return;
    }
    received.push(JSON.parse(channel.open(sealed)!));
  });
  const dialer = new RelayDialer({
    readPin: () => pin,
    ownerExists: () => true,
    computerKey: () => computerKey,
    appVersion: '0.143.0',
    server: {
      features: () => features,
      handle: () => undefined,
      closeAll: () => undefined,
      endStream: () => false,
    },
    connect: () => wire.computer,
  });
  dialer.onViewerOpen(LATER);
  wire.computer.fire('open');
  wire.pump();
  /** Seal one inner frame as the home, without sending it. */
  const seal = (frame: unknown) => encodeRelayFrame(channel!.seal(JSON.stringify(frame))!)!;
  const send = (text: string) => {
    wire.hub.send(text);
    wire.pump();
  };
  return { wire, dialer, received, seal, send };
}

describe('the computer’s half of the hello', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('agrees only what both signed lists name: a frame naming more never widens the set', () => {
    const home = rawHome([...CHAT_ONLY, 'tools.list', 'zz.unknown']);
    home.send(
      home.seal({ type: 'features', features: ['tools.list', 'tools.call', 'zz.unknown'] })
    );
    expect(home.dialer.agreedFeatures).toEqual(['tools.list']);
    expect(home.dialer.connected).toBe(true);
  });

  it('agrees nothing until the frame arrives', () => {
    const home = rawHome([...CHAT_ONLY, 'tools.list']);
    expect(home.dialer.agreedFeatures).toEqual([]);
  });

  it('closes on a second features frame', () => {
    const home = rawHome([...CHAT_ONLY, 'tools.list']);
    home.send(home.seal({ type: 'features', features: ['tools.list'] }));
    home.send(home.seal({ type: 'features', features: ['tools.list', 'tools.call'] }));
    expect(home.dialer.connected).toBe(false);
  });

  it('closes on a features frame that is not the first frame after finish', () => {
    const home = rawHome([...CHAT_ONLY, 'tools.list']);
    home.send(home.seal({ type: 'viewers', count: 1 }));
    home.send(home.seal({ type: 'features', features: ['tools.list'] }));
    expect(home.dialer.connected).toBe(false);
    expect(home.dialer.agreedFeatures).toEqual([]);
  });

  it('closes on a replayed features frame', () => {
    const home = rawHome([...CHAT_ONLY, 'tools.list']);
    const frame = home.seal({ type: 'features', features: ['tools.list'] });
    home.send(frame);
    expect(home.dialer.connected).toBe(true);
    home.send(frame);
    expect(home.dialer.connected).toBe(false);
  });

  it('keeps today’s strict reading when it named no agent-computer feature', () => {
    const home = rawHome(CHAT_ONLY);
    home.send(home.seal({ type: 'features', features: ['tools.list'] }));
    expect(home.dialer.connected).toBe(false);
  });

  it('answers a home request it does not serve with needs_update, and stays connected', () => {
    const home = rawHome([...CHAT_ONLY, 'agents.sync']);
    home.send(home.seal({ type: 'features', features: ['agents.sync'] }));
    home.send(
      home.seal({
        type: 'request',
        id: 'r1',
        request: { op: 'agents.sync', agentId: AGENT, remove: true },
      })
    );
    expect(home.received).toContainEqual({
      type: 'error',
      id: 'r1',
      ok: false,
      error: expect.objectContaining({ status: 501, code: 'needs_update', feature: 'agents.sync' }),
    });
    expect(home.dialer.connected).toBe(true);
  });
});
