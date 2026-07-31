/**
 * The NIP-01 wire vocabulary a Buzz relay speaks, and nothing above it.
 *
 * Every frame is a JSON array. This module owns the four things that are pure
 * data — the event shape, the frames in both directions, the tag accessors, and
 * the NIP-01 event id — so the connection, the history walk and the adapter can
 * each be about their own concern. Nothing here does I/O and nothing here knows
 * what a room is.
 *
 * The kind numbers are Buzz's, not generic Nostr's, and the citations are to the
 * Buzz checkout the capability spike read
 * (`research/20260727_buzz-protocol-capability-spike.md`, commit
 * `654f3849`). Buzz implements NIP-29 relay-based groups and explicitly does NOT
 * implement NIP-28 public chat — kind 41 is defined and dead, and kinds 40/42
 * appear nowhere — so a reader coming from generic Nostr should not expect the
 * channel kinds they know.
 *
 * @module server/services/communities/buzz/buzz-protocol
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';

/** A channel message. `crates/buzz-core/src/kind.rs:419`. */
export const KIND_STREAM_MESSAGE = 9;

/** NIP-42 authentication. The event a relay's AUTH challenge is answered with. */
export const KIND_CLIENT_AUTH = 22242;

/** Relay-signed channel metadata — one per channel this identity may see. `kind.rs:362`. */
export const KIND_GROUP_METADATA = 39000;

/** Relay-signed channel roster, one `p` tag per member. `kind.rs:366`. */
export const KIND_GROUP_MEMBERS = 39002;

/** A NIP-01 event, as it arrives on the wire. */
export const NostrEventSchema = z.object({
  /** 32-byte lowercase hex — sha256 over the canonical serialization. */
  id: z.string().regex(/^[0-9a-f]{64}$/),
  /** The author's 32-byte x-only public key, lowercase hex. */
  pubkey: z.string().regex(/^[0-9a-f]{64}$/),
  /** Unix seconds. Wall-clock, author-assigned, and never a sequence. */
  created_at: z.number().int().nonnegative(),
  /** Which kind of thing this is. */
  kind: z.number().int().nonnegative(),
  /** Positional string tuples. The first element names the tag. */
  tags: z.array(z.array(z.string())),
  /** The payload. For a kind-9 message this is the message text. */
  content: z.string(),
  /** 64-byte BIP-340 Schnorr signature over `id`, lowercase hex. */
  sig: z.string().regex(/^[0-9a-f]{128}$/),
});
/** A NIP-01 event. See {@link NostrEventSchema}. */
export type NostrEvent = z.infer<typeof NostrEventSchema>;

/**
 * A NIP-01 subscription filter.
 *
 * Only the members this adapter actually sends are modelled. `#h` scopes to a
 * channel and `#d` to a relay-signed replaceable event's identifier; both are the
 * generic NIP-01 single-letter tag filter, spelled out rather than left to an
 * index signature so a typo is a compile error.
 */
export interface NostrFilter {
  /** Kinds to match. */
  kinds?: number[];
  /** Channel scope — the `h` tag Buzz requires on every channel-scoped kind. */
  '#h'?: string[];
  /** Replaceable-event identifier — how a channel's metadata and roster are addressed. */
  '#d'?: string[];
  /** Event references — how a thread's replies are matched (NIP-10 `e` tags). */
  '#e'?: string[];
  /** Inclusive lower bound on `created_at`, in seconds. */
  since?: number;
  /** Inclusive upper bound on `created_at`, in seconds. */
  until?: number;
  /** Row cap. Buzz clamps it to 2000 (`handlers/req.rs:25`). */
  limit?: number;
}

/** Everything a relay can say to us, already discriminated. */
export type RelayFrame =
  | { type: 'AUTH'; challenge: string }
  | { type: 'EVENT'; subscriptionId: string; event: NostrEvent }
  | { type: 'EOSE'; subscriptionId: string }
  | { type: 'CLOSED'; subscriptionId: string; message: string }
  | { type: 'OK'; eventId: string; accepted: boolean; message: string }
  | { type: 'NOTICE'; message: string };

/**
 * Parse one relay frame, or `null` for anything this adapter does not model.
 *
 * Unrecognized frames are dropped rather than thrown on: a relay is free to
 * speak NIPs we do not, and a read-only client that fell over on a `COUNT`
 * response would be broken by somebody else's feature.
 *
 * @param raw - One WebSocket text frame.
 */
export function parseRelayFrame(raw: string): RelayFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || typeof parsed[0] !== 'string') return null;
  const [verb, a, b, c] = parsed as [string, unknown, unknown, unknown];

  switch (verb) {
    case 'AUTH':
      return typeof a === 'string' ? { type: 'AUTH', challenge: a } : null;
    case 'EVENT': {
      if (typeof a !== 'string') return null;
      const event = NostrEventSchema.safeParse(b);
      return event.success ? { type: 'EVENT', subscriptionId: a, event: event.data } : null;
    }
    case 'EOSE':
      return typeof a === 'string' ? { type: 'EOSE', subscriptionId: a } : null;
    case 'CLOSED':
      return typeof a === 'string'
        ? { type: 'CLOSED', subscriptionId: a, message: typeof b === 'string' ? b : '' }
        : null;
    case 'OK':
      return typeof a === 'string' && typeof b === 'boolean'
        ? { type: 'OK', eventId: a, accepted: b, message: typeof c === 'string' ? c : '' }
        : null;
    case 'NOTICE':
      return typeof a === 'string' ? { type: 'NOTICE', message: a } : null;
    default:
      return null;
  }
}

/**
 * Serialize a `REQ` — open a subscription. Buzz registers it BEFORE running the
 * historical query, so backfill and live arrive on one subscription with no gap
 * between them (`handlers/req.rs:364-386`). That property is what
 * `subscribeRoom` is built on.
 *
 * @param subscriptionId - Client-minted subscription id.
 * @param filters - One or more filters, OR-ed by the relay.
 */
export function encodeReq(subscriptionId: string, ...filters: NostrFilter[]): string {
  return JSON.stringify(['REQ', subscriptionId, ...filters]);
}

/**
 * Serialize a `CLOSE` — tear one subscription down.
 *
 * @param subscriptionId - The subscription to close.
 */
export function encodeClose(subscriptionId: string): string {
  return JSON.stringify(['CLOSE', subscriptionId]);
}

/**
 * Serialize an `AUTH` — answer the relay's challenge with a signed event.
 *
 * @param event - The signed kind-22242 event.
 */
export function encodeAuth(event: NostrEvent): string {
  return JSON.stringify(['AUTH', event]);
}

/**
 * The first value of the first tag with this name, or `undefined`.
 *
 * @param event - The event to read.
 * @param name - The tag name, e.g. `'d'`.
 */
export function tagValue(event: NostrEvent, name: string): string | undefined {
  return event.tags.find((tag) => tag[0] === name)?.[1];
}

/**
 * Whether a bare marker tag is present — `["public"]`, `["archived","true"]`.
 *
 * A Buzz metadata event says "this channel is public" by carrying a tag whose
 * name IS the fact, with no value, and says "archived" with the string `"true"`.
 * Both spellings are accepted here so a caller never has to know which one a
 * given fact uses (`handlers/side_effects.rs:1011-1058`).
 *
 * @param event - The event to read.
 * @param name - The marker tag name.
 */
export function hasMarker(event: NostrEvent, name: string): boolean {
  const tag = event.tags.find((entry) => entry[0] === name);
  if (!tag) return false;
  return tag[1] === undefined || tag[1] === '' || tag[1] === 'true';
}

/** One NIP-10 `e` tag, read for its marker. */
export interface ThreadTag {
  /** The referenced event id. */
  eventId: string;
  /** `'root'`, `'reply'`, or `undefined` for the unmarked positional form. */
  marker?: string;
}

/**
 * Every NIP-10 `e` tag on an event, in tag order.
 *
 * Buzz's ingest only considers the MARKED form — it requires `parts.len() >= 4`
 * and reads `parts[3]` as the marker (`handlers/ingest.rs:563-597`) — so an
 * unmarked `e` tag never established ancestry on the way in and must not be
 * allowed to invent one on the way out. It is still reported here, with no
 * marker, because the caller is the one place that can say what to do with it.
 *
 * @param event - The event to read.
 */
export function threadTags(event: NostrEvent): ThreadTag[] {
  const tags: ThreadTag[] = [];
  for (const tag of event.tags) {
    if (tag[0] !== 'e' || typeof tag[1] !== 'string') continue;
    tags.push(tag[3] === undefined ? { eventId: tag[1] } : { eventId: tag[1], marker: tag[3] });
  }
  return tags;
}

/**
 * The NIP-01 event id: sha256 over the canonical serialization
 * `[0, pubkey, created_at, kind, tags, content]`.
 *
 * `JSON.stringify` is the correct serializer here and not an approximation of
 * one: NIP-01 specifies UTF-8 JSON with no whitespace and the six values in this
 * order, which is exactly what it emits for an array of strings, numbers and
 * string arrays.
 *
 * @param event - The event's signable fields.
 */
export function eventId(event: Omit<NostrEvent, 'id' | 'sig'>): string {
  const serialized = JSON.stringify([
    0,
    event.pubkey,
    event.created_at,
    event.kind,
    event.tags,
    event.content,
  ]);
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}
