/**
 * One authenticated connection to one Buzz relay, and the subscription
 * multiplexing over it.
 *
 * This is the layer that knows Buzz is a WebSocket with a mandatory handshake and
 * N concurrent subscriptions on one socket. Above it, the adapter talks about
 * rooms; below it, {@link BuzzSocket} moves text. Nothing here knows what a room
 * is.
 *
 * **The handshake is not optional and its outcome is not a boolean.** The relay
 * pushes an `AUTH` challenge before reading a byte from us and kills the socket
 * five seconds later if it goes unanswered
 * (`crates/buzz-relay/src/connection.rs:157-197,27,228-249`). The answer is
 * verified as pure Schnorr, and then up to three gates run — a ban check that is
 * always on, a pubkey allowlist, and a relay-membership requirement
 * (`handlers/auth.rs:106-214`). Whether the last two are enabled is a property of
 * the deployment that no client can discover before trying, and every published
 * Buzz deployment enables membership. So "your key is fine, an operator has to
 * let you in" is a routine outcome, distinct from "your key is wrong", and this
 * client reports the difference rather than collapsing it into a failure. That is
 * what the port's four connection statuses are for.
 *
 * @module server/services/communities/buzz/buzz-relay-client
 */
import type { CommunityConnection, CommunityRef } from '@dorkos/shared/community-adapter';
import { logger } from '../../../lib/logger.js';
import { PushStream } from '../push-stream.js';
import { buildAuthEvent, type BuzzIdentity } from './buzz-identity.js';
import {
  encodeAuth,
  encodeClose,
  encodeReq,
  parseRelayFrame,
  type NostrEvent,
  type NostrFilter,
} from './buzz-protocol.js';
import type { BuzzSocket, BuzzSocketFactory } from './buzz-socket.js';

/** How long to wait for the socket, the challenge and the verdict, all told. */
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Thrown when the relay declines a read rather than answering it: a channel this
 * identity may not see, an authentication that has lapsed, a subscription evicted
 * mid-query.
 *
 * **A class, not a message prefix.** The adapter has to tell this apart from a
 * genuine fault — a refused read is answered with an empty page, a fault is not —
 * and the first version of that check matched on the start of the message string,
 * coupling two files through prose that neither compiler nor reviewer would catch
 * drifting. It is the same duck-typing the port's own typed errors exist to
 * remove; there is no reason for a module's internal boundary to be laxer than
 * its external one.
 */
export class BuzzReadRefusedError extends Error {
  /**
   * Name the refusal the relay sent.
   *
   * @param relayMessage - The relay's own `CLOSED` reason, kept for the log.
   */
  constructor(readonly relayMessage: string) {
    super(`the relay refused a read: ${relayMessage}`);
    this.name = 'BuzzReadRefusedError';
  }
}

/** What one subscription delivers. */
export type BuzzSubscriptionEvent =
  { type: 'event'; event: NostrEvent } | { type: 'eose' } | { type: 'closed'; message: string };

/** Everything a {@link BuzzRelayClient} is built from. */
export interface BuzzRelayClientDeps {
  /** The community this client serves — one relay host, one community. */
  community: CommunityRef;
  /** The relay's WebSocket URL. */
  relayUrl: string;
  /** This machine's key, already derived from the community credential. */
  identity: BuzzIdentity;
  /** How to open a socket. Injected so the whole protocol is testable without a port. */
  openSocket: BuzzSocketFactory;
  /** Budget for socket + challenge + verdict. Defaults to ten seconds. */
  connectTimeoutMs?: number;
}

/**
 * An authenticated Buzz relay connection.
 *
 * @example
 * ```typescript
 * const client = new BuzzRelayClient({ community, relayUrl, identity, openSocket });
 * const connection = await client.connect();
 * if (connection.status === 'connected') {
 *   const rooms = await client.query([{ kinds: [39000], limit: 500 }]);
 * }
 * ```
 */
export class BuzzRelayClient {
  private socket: BuzzSocket | null = null;
  private authenticated = false;
  private nextSubscriptionId = 0;
  private readonly subscriptions = new Map<string, PushStream<BuzzSubscriptionEvent>>();
  private pendingConnect: ((connection: CommunityConnection) => void) | null = null;
  private challengeAnswered = false;

  /**
   * Wire a client. Nothing opens until {@link BuzzRelayClient.connect} runs.
   *
   * @param deps - Community, relay URL, identity and socket factory.
   */
  constructor(private readonly deps: BuzzRelayClientDeps) {}

  /** The identity this client authenticates as — the member id Buzz knows us by. */
  get pubkey(): string {
    return this.deps.identity.pubkey;
  }

  /** Whether the handshake has completed and subscriptions may be opened. */
  get connected(): boolean {
    return this.authenticated;
  }

  /**
   * Open the socket and complete the NIP-42 handshake.
   *
   * Never throws for a connection outcome. Calling it twice on a live connection
   * is a no-op that re-reports success, so a caller that connects defensively
   * does not churn the socket.
   *
   * @param signal - Aborts an attempt that is taking too long.
   */
  connect(signal?: AbortSignal): Promise<CommunityConnection> {
    if (this.authenticated) {
      return Promise.resolve({
        status: 'connected',
        identity: { community: this.deps.community, memberId: this.pubkey },
      });
    }

    return new Promise<CommunityConnection>((resolve) => {
      const timeoutMs = this.deps.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS;
      const timer = setTimeout(() => {
        settle({
          status: 'unreachable',
          error: `the relay at '${this.deps.relayUrl}' did not complete a handshake within ${timeoutMs}ms`,
        });
      }, timeoutMs);
      (timer as { unref?: () => void }).unref?.();

      let settled = false;
      const settle = (connection: CommunityConnection): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.pendingConnect = null;
        if (connection.status !== 'connected')
          this.teardown(connection.error ?? 'handshake failed');
        resolve(connection);
      };
      this.pendingConnect = settle;

      const onAbort = (): void =>
        settle({ status: 'unreachable', error: 'the connect attempt was aborted' });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });

      this.challengeAnswered = false;
      this.socket = this.deps.openSocket(this.deps.relayUrl, {
        onOpen: () => {},
        onFrame: (raw) => this.onFrame(raw),
        onClose: (reason) => this.onClose(reason),
      });
    });
  }

  /**
   * Run one historical query: open a subscription, collect until `EOSE`, close.
   *
   * A `CLOSED` before `EOSE` is the relay refusing the read — a channel this
   * identity may not see, or an expired authentication — and it rejects rather
   * than resolving empty, because "you may not read this" and "there is nothing
   * here" are different answers and only the caller knows which one it can act on.
   *
   * @param filters - NIP-01 filters, OR-ed by the relay.
   * @param signal - Aborts the query.
   * @throws {Error} When the relay closes the subscription, or the socket drops.
   */
  async query(filters: NostrFilter[], signal?: AbortSignal): Promise<NostrEvent[]> {
    const subscription = this.subscribe(filters, signal);
    const events: NostrEvent[] = [];
    for await (const event of subscription.events) {
      if (event.type === 'event') {
        events.push(event.event);
        continue;
      }
      if (event.type === 'eose') break;
      throw new BuzzReadRefusedError(event.message);
    }
    subscription.close();
    return events;
  }

  /**
   * Open a live subscription. The relay registers it BEFORE running the
   * historical query, so backfill and live arrive on one stream with no gap
   * between them (`handlers/req.rs:364-386`) — which is the property
   * `subscribeRoom` is built on and could not reconstruct from two calls.
   *
   * @param filters - NIP-01 filters, OR-ed by the relay.
   * @param signal - Aborts the subscription.
   */
  subscribe(
    filters: NostrFilter[],
    signal?: AbortSignal
  ): { events: AsyncIterable<BuzzSubscriptionEvent>; close: () => void } {
    const subscriptionId = `dorkos-${(this.nextSubscriptionId += 1)}`;
    const stream = new PushStream<BuzzSubscriptionEvent>(() => {
      this.subscriptions.delete(subscriptionId);
      this.socket?.send(encodeClose(subscriptionId));
    });
    this.subscriptions.set(subscriptionId, stream);

    if (!this.authenticated) {
      // Not an exception: a subscription opened against a dropped connection is
      // a race a caller cannot avoid, and the stream's own terminal event is how
      // every other close is reported.
      stream.push({ type: 'closed', message: 'not connected to the relay' });
      stream.end();
    } else {
      this.socket?.send(encodeReq(subscriptionId, ...filters));
    }

    if (signal) {
      if (signal.aborted) stream.end();
      else signal.addEventListener('abort', () => stream.end(), { once: true });
    }
    return { events: stream, close: () => stream.end() };
  }

  /** Close the socket and end every open subscription. Idempotent. */
  disconnect(): void {
    this.teardown('disconnected');
  }

  // --- Internals -------------------------------------------------------------

  /**
   * Route one relay frame.
   *
   * @param raw - The frame, as received.
   */
  private onFrame(raw: string): void {
    const frame = parseRelayFrame(raw);
    if (!frame) return;

    switch (frame.type) {
      case 'AUTH':
        this.answerChallenge(frame.challenge);
        return;
      case 'OK':
        // The only `OK` this read-only client can provoke is the verdict on its
        // own auth event: it never publishes anything else.
        this.settleHandshake(frame.accepted, frame.message);
        return;
      case 'EVENT':
        this.subscriptions.get(frame.subscriptionId)?.push({ type: 'event', event: frame.event });
        return;
      case 'EOSE':
        this.subscriptions.get(frame.subscriptionId)?.push({ type: 'eose' });
        return;
      case 'CLOSED': {
        const stream = this.subscriptions.get(frame.subscriptionId);
        stream?.push({ type: 'closed', message: frame.message });
        stream?.end();
        return;
      }
      case 'NOTICE':
        logger.debug('[BuzzCommunity] relay notice', {
          community: this.deps.community,
          message: frame.message,
        });
        return;
    }
  }

  /**
   * Sign and send the answer to the relay's challenge.
   *
   * Answered once per socket. A relay is free to re-challenge, and signing every
   * challenge blindly would let a live connection be reset by a stray frame.
   *
   * @param challenge - The challenge string.
   */
  private answerChallenge(challenge: string): void {
    if (this.challengeAnswered) return;
    this.challengeAnswered = true;
    this.socket?.send(
      encodeAuth(buildAuthEvent(this.deps.identity, this.deps.relayUrl, challenge))
    );
  }

  /**
   * Turn the relay's verdict into one of the port's four statuses.
   *
   * The three refusal strings are Buzz's own (`handlers/auth.rs:277-294`), and
   * the split between them is the distinction the port exists to preserve:
   * `restricted:` means the key verified and this deployment has not admitted it,
   * which a person can act on by asking an operator; everything else means the
   * credential itself was refused, which they cannot act on at all and must not
   * be told to.
   *
   * @param accepted - Whether the relay accepted the auth event.
   * @param message - The relay's message.
   */
  private settleHandshake(accepted: boolean, message: string): void {
    if (accepted) {
      this.authenticated = true;
      this.pendingConnect?.({
        status: 'connected',
        identity: { community: this.deps.community, memberId: this.pubkey },
      });
      return;
    }

    if (message.startsWith('restricted:')) {
      this.pendingConnect?.({
        status: 'not-admitted',
        disclosure:
          'Your key is valid, but whoever runs this community has not let it in yet. Ask them to add it — there is no way to request access from here.',
        error: message,
      });
      return;
    }
    this.pendingConnect?.({
      status: 'unauthorized',
      error: message || 'the relay rejected this identity',
    });
  }

  /**
   * The socket went away.
   *
   * @param reason - Plain-language detail.
   */
  private onClose(reason: string): void {
    // A close during the handshake is the unreachable case: the relay never got
    // as far as saying anything about our key.
    this.pendingConnect?.({
      status: 'unreachable',
      error: `the relay at '${this.deps.relayUrl}' closed the connection: ${reason}`,
    });
    this.teardown(reason);
  }

  /**
   * Drop the socket and end every subscription with a terminal frame.
   *
   * @param reason - Why, for the terminal event each open stream gets.
   */
  private teardown(reason: string): void {
    this.authenticated = false;
    for (const [subscriptionId, stream] of [...this.subscriptions]) {
      this.subscriptions.delete(subscriptionId);
      stream.push({ type: 'closed', message: reason });
      stream.end();
    }
    const socket = this.socket;
    this.socket = null;
    socket?.close();
  }
}
