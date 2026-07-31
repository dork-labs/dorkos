/**
 * A Buzz relay, in process, speaking real NIP-01 frames.
 *
 * This is not a mock of the adapter and it is deliberately not a mock of the
 * client either — it implements {@link BuzzSocketFactory}, the lowest seam there
 * is, so **every line of shipped protocol code stays in the path**: the NIP-42
 * handshake with a real Schnorr verification, the subscription multiplexing, the
 * filter semantics, the `EOSE` boundary, the eviction `CLOSED`, and the history
 * walk's window narrowing. A test that passes here has exercised the same code a
 * real relay would drive.
 *
 * What it models, and what it refuses to model, is taken from the capability
 * spike's source citations (`research/20260727_buzz-protocol-capability-spike.md`):
 *
 * - **Auth is mandatory and unconditional.** A `REQ` from an unauthenticated
 *   connection is answered with a `NOTICE` and a `CLOSED`, exactly as
 *   `handlers/req.rs:50-87` does. There is no anonymous read.
 * - **The three verdicts are distinct strings**, because the whole point of the
 *   port's four connection statuses is that they are distinguishable
 *   (`handlers/auth.rs:277-294`).
 * - **Accessible channels are the union** of "channels I am a member of" and
 *   "every open channel", which is the relay's own SQL (`db/channel.rs:746-773`).
 * - **Discovery events are synthesized at query time** from channel state, which
 *   is what makes them channel-scoped and therefore un-pushable — the reason the
 *   adapter polls (`side_effects.rs:999-1108`).
 * - **`limit` semantics are a knob**, not a fact. NIP-01's convention returns the
 *   newest matching events; a relay implementing it as a plain SQL limit returns
 *   the oldest. The adapter must be correct under both, so the fake can be either
 *   and the conformance suite is registered twice.
 *
 * @module server/services/communities/buzz/__tests__/fake-buzz-relay
 */
import { schnorr } from '@noble/curves/secp256k1.js';
import { deriveBuzzIdentity, type BuzzIdentity } from '../buzz-identity.js';
import {
  eventId,
  KIND_CLIENT_AUTH,
  KIND_GROUP_MEMBERS,
  KIND_GROUP_METADATA,
  KIND_STREAM_MESSAGE,
  NostrEventSchema,
  type NostrEvent,
  type NostrFilter,
} from '../buzz-protocol.js';
import type { BuzzSocket, BuzzSocketFactory, BuzzSocketHandlers } from '../buzz-socket.js';

/** Which end of the range a relay's `limit` keeps. Both are real implementations. */
export type LimitSemantics = 'newest' | 'oldest';

/** How this relay is configured — the deployment facts an adapter cannot discover. */
export interface FakeBuzzRelayOpts {
  /** The relay's own key, for signing discovery and roster events. */
  relaySecret?: string;
  /** Whether an authenticated stranger is refused until an operator admits them. */
  requireRelayMembership?: boolean;
  /** Pubkeys the relay has banned. Refused at the handshake, before anything else. */
  banned?: string[];
  /** Which end of a range `limit` keeps. Defaults to `'newest'`, NIP-01's convention. */
  limitSemantics?: LimitSemantics;
  /** Rows one read may return, whatever the filter asked for. Buzz clamps to 2000. */
  maxLimit?: number;
}

/** One channel, as this relay holds it. */
interface FakeChannel {
  id: string;
  name: string;
  topic: string | null;
  type: string;
  visibility: 'open' | 'private';
  archived: boolean;
  /** Pubkey → role. */
  members: Map<string, string>;
  /** When the metadata last changed, in unix seconds. */
  metadataAt: number;
}

/** A relay-level member — the `relay_members` row `buzz-admin add-member` writes. */
type RelayMember = string;

/**
 * A Buzz relay for tests.
 *
 * @example
 * ```typescript
 * const relay = new FakeBuzzRelay({ requireRelayMembership: true });
 * relay.admitToRelay(pubkey);
 * const channel = relay.createChannel({ name: 'engineering' });
 * relay.addMember(channel, pubkey, 'member');
 * const adapter = new BuzzCommunityAdapter({ ..., openSocket: relay.socketFactory() });
 * ```
 */
export class FakeBuzzRelay {
  private readonly identity: BuzzIdentity;
  private readonly channels = new Map<string, FakeChannel>();
  private readonly messages: NostrEvent[] = [];
  private readonly relayMembers = new Set<RelayMember>();
  private readonly connections = new Set<FakeConnection>();
  private clock = 1_780_000_000;
  private nextChannel = 0;

  /**
   * Build a relay.
   *
   * @param opts - Deployment configuration.
   */
  constructor(private readonly opts: FakeBuzzRelayOpts = {}) {
    this.identity = deriveBuzzIdentity(opts.relaySecret ?? 'fake-buzz-relay-signing-key');
  }

  /** A factory the adapter can be constructed with. */
  socketFactory(): BuzzSocketFactory {
    return (url, handlers) => {
      const connection = new FakeConnection(this, url, handlers);
      this.connections.add(connection);
      return connection;
    };
  }

  // --- The admin tool --------------------------------------------------------

  /**
   * Admit a pubkey to the community — what an operator does with
   * `buzz-admin add-member`, and the only way in when membership is required.
   *
   * @param pubkey - The key to admit.
   */
  admitToRelay(pubkey: string): void {
    this.relayMembers.add(pubkey);
  }

  /**
   * Remove a pubkey from the community.
   *
   * @param pubkey - The key to remove.
   */
  removeFromRelay(pubkey: string): void {
    this.relayMembers.delete(pubkey);
  }

  /**
   * Create a channel.
   *
   * @param input - Its name, and anything not defaulted.
   */
  createChannel(
    input: {
      name?: string;
      topic?: string | null;
      type?: string;
      visibility?: 'open' | 'private';
    } = {}
  ): string {
    this.nextChannel += 1;
    const id = `00000000-0000-4000-8000-${String(this.nextChannel).padStart(12, '0')}`;
    this.channels.set(id, {
      id,
      name: input.name ?? `channel-${this.nextChannel}`,
      topic: input.topic ?? null,
      type: input.type ?? 'stream',
      visibility: input.visibility ?? 'open',
      archived: false,
      members: new Map(),
      metadataAt: (this.clock += 1),
    });
    return id;
  }

  /**
   * Put a pubkey on a channel's roster.
   *
   * @param channelId - The channel.
   * @param pubkey - The member.
   * @param role - One of Buzz's five roles.
   */
  addMember(channelId: string, pubkey: string, role = 'member'): void {
    const channel = this.require(channelId);
    channel.members.set(pubkey, role);
    channel.metadataAt = this.clock += 1;
  }

  /**
   * Post a message as some author.
   *
   * @param input - The channel, the author's secret, the text, and any thread tags.
   */
  post(input: {
    channelId: string;
    authorSecret: string;
    text: string;
    /** The thread root this reply hangs off, if any. */
    rootId?: string;
    /** The entry replied to, when it is not the root. */
    parentId?: string;
    /** Force a `created_at`, to arrange ties and skew. */
    createdAt?: number;
  }): NostrEvent {
    const author = deriveBuzzIdentity(input.authorSecret);
    const tags: string[][] = [['h', input.channelId]];
    if (input.rootId) tags.push(['e', input.rootId, '', 'root']);
    if (input.parentId) tags.push(['e', input.parentId, '', 'reply']);
    const event = author.sign({
      created_at: input.createdAt ?? (this.clock += 1),
      kind: KIND_STREAM_MESSAGE,
      tags,
      content: input.text,
    });
    this.messages.push(event);
    this.fanOut(input.channelId, event);
    return event;
  }

  /**
   * Archive a channel — which in Buzz evicts every live subscription on it with
   * the SAME `CLOSED` string an open-to-private flip produces
   * (`side_effects.rs:85,95-128`). That collision is why an adapter must report
   * `'unknown'` rather than guessing `'archived'`, and this method exists to
   * prove it does.
   *
   * @param channelId - The channel to archive.
   */
  archiveChannel(channelId: string): void {
    const channel = this.require(channelId);
    channel.archived = true;
    channel.metadataAt = this.clock += 1;
    for (const connection of this.connections) {
      connection.evict(channelId, 'restricted: channel access revoked');
    }
  }

  /**
   * Delete a channel outright, so a room-list poll reports it removed.
   *
   * @param channelId - The channel to delete.
   */
  deleteChannel(channelId: string): void {
    this.channels.delete(channelId);
  }

  // --- The relay ------------------------------------------------------------

  /**
   * Whether a key may connect at all, and what to say when it may not.
   *
   * @param pubkey - The authenticating key.
   */
  admissionVerdict(pubkey: string): { ok: true } | { ok: false; message: string } {
    if (this.opts.banned?.includes(pubkey)) {
      return { ok: false, message: 'blocked: you are banned from this community' };
    }
    if (this.opts.requireRelayMembership && !this.relayMembers.has(pubkey)) {
      return { ok: false, message: 'restricted: not a relay member' };
    }
    return { ok: true };
  }

  /**
   * Every channel a key may read: the ones it belongs to, plus every open one.
   *
   * @param pubkey - The reading key.
   */
  accessibleChannels(pubkey: string): FakeChannel[] {
    return [...this.channels.values()].filter(
      (channel) => channel.visibility === 'open' || channel.members.has(pubkey)
    );
  }

  /**
   * Run one historical query, as the relay would.
   *
   * @param pubkey - The reading key.
   * @param filters - The filters, OR-ed.
   */
  historical(pubkey: string, filters: NostrFilter[]): NostrEvent[] {
    const accessible = new Set(this.accessibleChannels(pubkey).map((channel) => channel.id));
    const candidates = [
      ...this.messages.filter((event) => accessible.has(tag(event, 'h') ?? '')),
      ...this.accessibleChannels(pubkey).flatMap((channel) => [
        this.metadataEvent(channel),
        this.rosterEvent(channel),
      ]),
    ];

    const matched = new Map<string, NostrEvent>();
    for (const filter of filters) {
      for (const event of this.applyLimit(
        candidates.filter((event) => matches(event, filter)),
        filter.limit
      )) {
        matched.set(event.id, event);
      }
    }
    return [...matched.values()];
  }

  /**
   * Whether a filter names a channel this key may not read — the relay's
   * `restricted: not a channel member` refusal (`handlers/req.rs:160-171`).
   *
   * @param pubkey - The reading key.
   * @param filters - The filters.
   */
  refusedScope(pubkey: string, filters: NostrFilter[]): string | null {
    const accessible = new Set(this.accessibleChannels(pubkey).map((channel) => channel.id));
    for (const filter of filters) {
      for (const channelId of filter['#h'] ?? []) {
        if (!accessible.has(channelId)) return 'restricted: not a channel member';
      }
    }
    return null;
  }

  /** The relay's signing identity, so a test can recognise a relay-signed event. */
  get relayPubkey(): string {
    return this.identity.pubkey;
  }

  /**
   * Forget a connection that has closed.
   *
   * @param connection - The connection to drop.
   */
  drop(connection: FakeConnection): void {
    this.connections.delete(connection);
  }

  /**
   * The relay-signed kind-39000 metadata event for a channel.
   *
   * @param channel - The channel to describe.
   */
  private metadataEvent(channel: FakeChannel): NostrEvent {
    const tags: string[][] = [
      ['d', channel.id],
      ['name', channel.name],
      [channel.visibility === 'open' ? 'public' : 'private'],
      ['closed'],
      ['t', channel.type],
    ];
    if (channel.topic) tags.push(['topic', channel.topic]);
    if (channel.archived) tags.push(['archived', 'true']);
    return this.identity.sign({
      created_at: channel.metadataAt,
      kind: KIND_GROUP_METADATA,
      tags,
      content: '',
    });
  }

  /**
   * The relay-signed kind-39002 roster event for a channel.
   *
   * @param channel - The channel whose roster to sign.
   */
  private rosterEvent(channel: FakeChannel): NostrEvent {
    return this.identity.sign({
      created_at: channel.metadataAt,
      kind: KIND_GROUP_MEMBERS,
      tags: [
        ['d', channel.id],
        ...[...channel.members].map(([pubkey, role]) => ['p', pubkey, '', role]),
      ],
      content: '',
    });
  }

  /**
   * Keep at most `limit` rows, from whichever end this relay favours.
   *
   * @param events - The matching events.
   * @param limit - The filter's limit, if any.
   */
  private applyLimit(events: NostrEvent[], limit: number | undefined): NostrEvent[] {
    const capped = Math.min(limit ?? Number.MAX_SAFE_INTEGER, this.opts.maxLimit ?? 2000);
    const ordered = [...events].sort(
      (a, b) => a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    );
    if (ordered.length <= capped) return ordered;
    return (this.opts.limitSemantics ?? 'newest') === 'newest'
      ? ordered.slice(-capped)
      : ordered.slice(0, capped);
  }

  /**
   * Deliver a new message to every live subscription that wants it.
   *
   * @param channelId - The channel it landed in.
   * @param event - The event.
   */
  private fanOut(channelId: string, event: NostrEvent): void {
    for (const connection of this.connections) connection.deliver(channelId, event);
  }

  /**
   * The channel, or a loud failure — a fixture asking about a channel that does
   * not exist is a broken test, not a relay condition.
   *
   * @param channelId - The channel to resolve.
   */
  private require(channelId: string): FakeChannel {
    const channel = this.channels.get(channelId);
    if (!channel) throw new Error(`fake relay: no such channel '${channelId}'`);
    return channel;
  }
}

/** One WebSocket-shaped connection to {@link FakeBuzzRelay}. */
class FakeConnection implements BuzzSocket {
  private readonly challenge = `challenge-${Math.random().toString(16).slice(2)}`;
  private pubkey: string | null = null;
  private closed = false;
  private readonly subscriptions = new Map<string, NostrFilter[]>();

  /**
   * Open a connection and push the challenge, unprompted, as Buzz does before
   * reading a byte from the client (`connection.rs:157-197`).
   *
   * @param relay - The relay behind it.
   * @param url - The URL dialled, echoed back into the NIP-42 verification.
   * @param handlers - Where frames go.
   */
  constructor(
    private readonly relay: FakeBuzzRelay,
    private readonly url: string,
    private readonly handlers: BuzzSocketHandlers
  ) {
    setTimeout(() => {
      if (this.closed) return;
      this.handlers.onOpen();
      this.emit(['AUTH', this.challenge]);
    }, 0);
  }

  send(raw: string): void {
    if (this.closed) return;
    // A microtask, not a timer. It keeps every frame asynchronous — which is
    // what makes the client's ordering assumptions real — without paying a
    // macrotask per frame, which turned a suite that walks history in pages into
    // one that timed out under parallel load.
    queueMicrotask(() => this.receive(raw));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.relay.drop(this);
    this.handlers.onClose('closed by the client');
  }

  /**
   * Deliver a live event to every subscription scoped to a channel.
   *
   * @param channelId - The channel the event landed in.
   * @param event - The event.
   */
  deliver(channelId: string, event: NostrEvent): void {
    if (this.closed || !this.pubkey) return;
    for (const [subscriptionId, filters] of this.subscriptions) {
      const wants = filters.some(
        (filter) =>
          (filter['#h'] ?? []).includes(channelId) &&
          matches(event, { ...filter, since: undefined, until: undefined, limit: undefined })
      );
      if (wants) this.emit(['EVENT', subscriptionId, event]);
    }
  }

  /**
   * Evict every subscription on a channel, the way archiving does.
   *
   * @param channelId - The channel.
   * @param message - The relay's one reason string for two different causes.
   */
  evict(channelId: string, message: string): void {
    if (this.closed) return;
    for (const [subscriptionId, filters] of [...this.subscriptions]) {
      if (!filters.some((filter) => (filter['#h'] ?? []).includes(channelId))) continue;
      this.subscriptions.delete(subscriptionId);
      this.emit(['CLOSED', subscriptionId, message]);
    }
  }

  /**
   * Handle one client frame.
   *
   * @param raw - The frame.
   */
  private receive(raw: string): void {
    if (this.closed) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!Array.isArray(parsed)) return;
    const [verb, ...rest] = parsed as [string, ...unknown[]];

    if (verb === 'AUTH') return this.handleAuth(rest[0]);
    if (verb === 'CLOSE') {
      this.subscriptions.delete(String(rest[0]));
      return;
    }
    if (verb === 'REQ') return this.handleReq(String(rest[0]), rest.slice(1) as NostrFilter[]);
  }

  /**
   * Verify a NIP-42 event and answer with the verdict.
   *
   * The signature and the event id are BOTH checked, and against the challenge
   * this connection issued — so a client that signs the wrong thing, or signs
   * nothing, fails here rather than sliding through on a shape check.
   *
   * @param candidate - The claimed auth event.
   */
  private handleAuth(candidate: unknown): void {
    const parsed = NostrEventSchema.safeParse(candidate);
    const reject = (message: string): void => {
      this.emit(['OK', parsed.success ? parsed.data.id : 'malformed', false, message]);
    };
    if (!parsed.success) return reject('auth-required: verification failed');

    const event = parsed.data;
    const wellFormed =
      event.kind === KIND_CLIENT_AUTH &&
      eventId(event) === event.id &&
      event.tags.some((t) => t[0] === 'challenge' && t[1] === this.challenge) &&
      event.tags.some((t) => t[0] === 'relay' && t[1] === this.url) &&
      schnorr.verify(hex(event.sig), hex(event.id), hex(event.pubkey));
    if (!wellFormed) return reject('auth-required: verification failed');

    const verdict = this.relay.admissionVerdict(event.pubkey);
    if (!verdict.ok) return reject(verdict.message);

    this.pubkey = event.pubkey;
    this.emit(['OK', event.id, true, '']);
  }

  /**
   * Register a subscription, then answer it — in that order, which is the whole
   * reason a Buzz backfill has no gap before its live tail.
   *
   * @param subscriptionId - The client's subscription id.
   * @param filters - The filters.
   */
  private handleReq(subscriptionId: string, filters: NostrFilter[]): void {
    if (!this.pubkey) {
      this.emit(['NOTICE', 'auth-required: authenticate before subscribing']);
      this.emit(['CLOSED', subscriptionId, 'auth-required: not authenticated']);
      return;
    }
    const refused = this.relay.refusedScope(this.pubkey, filters);
    if (refused) {
      this.emit(['CLOSED', subscriptionId, refused]);
      return;
    }

    this.subscriptions.set(subscriptionId, filters);
    for (const event of this.relay.historical(this.pubkey, filters)) {
      this.emit(['EVENT', subscriptionId, event]);
    }
    this.emit(['EOSE', subscriptionId]);
  }

  /**
   * Send one frame to the client.
   *
   * @param frame - The frame, as an array.
   */
  private emit(frame: unknown[]): void {
    if (this.closed) return;
    this.handlers.onFrame(JSON.stringify(frame));
  }
}

/**
 * NIP-01 filter matching, as much of it as this adapter sends.
 *
 * @param event - The candidate event.
 * @param filter - The filter.
 */
function matches(event: NostrEvent, filter: NostrFilter): boolean {
  if (filter.kinds && !filter.kinds.includes(event.kind)) return false;
  if (filter.since !== undefined && event.created_at < filter.since) return false;
  if (filter.until !== undefined && event.created_at > filter.until) return false;
  for (const name of ['h', 'd', 'e'] as const) {
    const wanted = filter[`#${name}`];
    if (!wanted) continue;
    const present = event.tags.filter((t) => t[0] === name).map((t) => t[1]);
    if (!present.some((value) => value !== undefined && wanted.includes(value))) return false;
  }
  return true;
}

/**
 * Hex to bytes — the curve library takes bytes, the wire carries hex.
 *
 * @param value - Lowercase hex.
 */
function hex(value: string): Uint8Array {
  return Uint8Array.from(Buffer.from(value, 'hex'));
}

/**
 * The first value of a tag.
 *
 * @param event - The event.
 * @param name - The tag name.
 */
function tag(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((t) => t[0] === name)?.[1];
}
