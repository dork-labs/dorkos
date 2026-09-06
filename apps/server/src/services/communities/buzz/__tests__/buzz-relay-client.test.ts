/**
 * @vitest-environment node
 *
 * What happens after the socket goes away — the half of a long-lived relay
 * connection that only exists when something has already gone wrong.
 *
 * A relay restarts, a deploy rolls, a NAT forgets an idle connection. The
 * client had one answer to all of them: end every subscription and stay down
 * forever, while every read above it came back as an empty room. This file is
 * the two properties that replace it — the connection comes back, and until it
 * does a read FAILS rather than answering.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../../lib/logger.js';
import { deriveBuzzIdentity } from '../buzz-identity.js';
import { KIND_GROUP_METADATA } from '../buzz-protocol.js';
import {
  BuzzDisconnectedError,
  BuzzReadRefusedError,
  BuzzRelayClient,
} from '../buzz-relay-client.js';
import { FakeBuzzRelay } from './fake-buzz-relay.js';

/** The credential this file's identity derives from. */
const CREDENTIAL = 'a'.repeat(63) + '2';

/** Fast enough that a retry lands inside a test, slow enough to be a real timer. */
const RECONNECT_BASE_MS = 5;

/** One client over one relay that has already admitted its key. */
function connectable(opts: { relay?: FakeBuzzRelay } = {}): {
  relay: FakeBuzzRelay;
  client: BuzzRelayClient;
} {
  const relay = opts.relay ?? new FakeBuzzRelay({ requireRelayMembership: true });
  const identity = deriveBuzzIdentity(CREDENTIAL);
  relay.admitToRelay(identity.pubkey);
  const client = new BuzzRelayClient({
    community: 'buzz-reconnect' as CommunityRef,
    relayUrl: 'ws://fake-relay.test/',
    identity,
    openSocket: relay.socketFactory(),
    connectTimeoutMs: 500,
    reconnectBaseDelayMs: RECONNECT_BASE_MS,
  });
  return { relay, client };
}

/** Wait for a condition, or fail naming what never happened. */
async function until(what: string, predicate: () => boolean, budgetMs = 500): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  throw new Error(`timed out after ${budgetMs}ms waiting for ${what}`);
}

describe('BuzzRelayClient reconnection', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('comes back after the relay drops an established connection', async () => {
    const { relay, client } = connectable();
    relay.createChannel({ name: 'engineering' });
    expect((await client.connect()).status).toBe('connected');

    relay.dropConnections();
    expect(client.connected, 'the drop is real: nothing is connected the instant it lands').toBe(
      false
    );

    await until('the client to reconnect on its own', () => client.connected);

    // Not merely a flag: the connection is usable again, which is the only
    // claim worth making about a reconnect.
    const events = await client.query([{ kinds: [KIND_GROUP_METADATA], limit: 10 }]);
    expect(events.length, 'a reconnected client reads again').toBeGreaterThan(0);
    client.disconnect();
  });

  it('tells a read that failed because the socket is gone apart from one the relay refused', async () => {
    // The distinction the adapter above this branches on. A refusal means "you
    // may not read this", which a channel answers with an empty page; a dropped
    // socket means nothing about the channel at all, and answering it the same
    // way is how every room came back empty until the process restarted.
    const { relay, client } = connectable();
    const channelId = relay.createChannel({ name: 'engineering' });
    await client.connect();

    relay.dropConnections();
    const failure = await client
      .query([{ kinds: [KIND_GROUP_METADATA], '#d': [channelId], limit: 1 }])
      .catch((err: unknown) => err);

    expect(
      failure,
      'a read attempted with no connection is a failure, never an empty answer'
    ).toBeInstanceOf(BuzzDisconnectedError);
    expect(
      failure,
      'and it is emphatically not the relay refusing, which is answered with an empty page'
    ).not.toBeInstanceOf(BuzzReadRefusedError);
    client.disconnect();
  });

  it('still reports a genuine relay refusal as a refusal', async () => {
    // The other side of the same branch, so the new error class cannot quietly
    // swallow the old one: a channel this key may not read is refused BY THE
    // RELAY, over a connection that is perfectly healthy.
    const { relay, client } = connectable();
    const secret = relay.createChannel({ name: 'secret', visibility: 'private' });
    await client.connect();

    const failure = await client
      .query([{ kinds: [KIND_GROUP_METADATA], '#h': [secret], limit: 1 }])
      .catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(BuzzReadRefusedError);
    expect(failure).not.toBeInstanceOf(BuzzDisconnectedError);
    client.disconnect();
  });

  it('does not reconnect after the caller disconnected', async () => {
    const { relay, client } = connectable();
    await client.connect();

    client.disconnect();
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_BASE_MS * 8));

    expect(
      client.connected,
      'a client the caller closed stays closed; reconnecting would resurrect a socket nobody asked for'
    ).toBe(false);
    expect(relay).toBeTruthy();
  });

  it('does not retry a relay that refused this key', async () => {
    // A verdict about the credential says the same thing every time, so
    // retrying it is a loop that never ends and never helps. Only the transport
    // is worth another attempt.
    const identity = deriveBuzzIdentity(CREDENTIAL);
    const relay = new FakeBuzzRelay({ banned: [identity.pubkey] });
    const client = new BuzzRelayClient({
      community: 'buzz-banned' as CommunityRef,
      relayUrl: 'ws://fake-relay.test/',
      identity,
      openSocket: relay.socketFactory(),
      connectTimeoutMs: 500,
      reconnectBaseDelayMs: RECONNECT_BASE_MS,
    });

    expect((await client.connect()).status).toBe('unauthorized');
    await new Promise((resolve) => setTimeout(resolve, RECONNECT_BASE_MS * 8));
    expect(client.connected, 'a banned key does not become admitted by trying again').toBe(false);
    client.disconnect();
  });
});
