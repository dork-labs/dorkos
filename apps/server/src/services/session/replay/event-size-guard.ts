/**
 * A byte budget for the session stream, which until now had only a count.
 *
 * `RING_BUFFER_MAX_EVENTS` and `EVENT_LOG_MAX_EVENTS` bound how MANY events a
 * session retains and say nothing about how big they are. That was survivable
 * while every event was a sentence of text; it stopped being survivable the
 * moment a message part could stand for an image. The rule this module
 * enforces is that no single event may be arbitrarily large, and — with the
 * byte caps in `RingBuffer` and `EventLog` — that a session's replay window is
 * bounded in bytes as well as in entries.
 *
 * **It degrades visibly, never silently.** An oversized string is replaced by a
 * marker that says how much was dropped and why, so the reader sees a stated
 * omission rather than a truncation they cannot tell from the real thing. The
 * event keeps its type, its ids and its shape, so nothing downstream — the tool
 * card that is waiting to complete, the turn that is waiting to close — is
 * stranded by the guard.
 *
 * Images are the reason this exists and are also the thing least likely to trip
 * it: an `image_attachment` carries a URL, not bytes (see `sessionImageShape`
 * in `packages/shared/src/schemas.ts`), which is precisely the arrangement that
 * keeps a two-megabyte picture from being re-sent on every reconnect. The guard
 * is the backstop for everything that is not so careful.
 *
 * Lives in `replay/` beside the two buffers it bounds, because the three of
 * them are one concept: the window a reconnecting client can be caught up from.
 *
 * **The move was forced by a real gate, not chosen.** `scripts/check-dir-size.sh`
 * (`ERROR_THRESHOLD=25` at `:24`, `WARN_THRESHOLD=15` at `:23`) runs as the
 * `dir-size` pre-commit command in `lefthook.yml` and fails any commit that
 * ADDS a source file to a directory already at the error threshold — its
 * "growth" tier. `services/session/` stood at 36 before this change, so a new
 * file at that level was refused outright:
 *
 *   ERROR: apps/server/src/services/session has 37 source files (max 25)
 *
 * The gate is fixture-tested (`scripts/test-check-dir-size.sh`), and its second
 * "census" tier reports every tracked directory over the cap on every commit
 * without blocking: `services/tasks` (36), `services/session` (34, this one),
 * `entities/session/model` (29) and `services/core` (26) all sit above it
 * today, so a growing directory here is debt the repo already carries rather
 * than something this change invented.
 *
 * Named this precisely on purpose. The threshold lives ONLY in that script: it
 * is not in `AGENTS.md`, `.claude/rules/` or `contributing/`, and the script's
 * own `contributing/project-structure.md` pointer leads to a guide that never
 * mentions a limit. A reviewer who searched the documentation concluded the
 * rule did not exist and that this directory was invented scope. It is not —
 * but the constraint is undiscoverable from where a reader looks, so the
 * citation is the map.
 *
 * @module services/session/replay/event-size-guard
 */
import type { SessionEvent } from '@dorkos/shared/session-stream';

/**
 * The largest single string an event may carry, in bytes.
 *
 * A quarter of a mebibyte. Well past any real payload — the longest thing a
 * turn legitimately puts on this stream is a tool result, and a command whose
 * output runs to a quarter-million characters is already unreadable — while
 * being small enough that two hundred of them cannot exhaust the ring's byte
 * budget on their own.
 */
export const MAX_EVENT_STRING_BYTES = 256 * 1024;

/**
 * Total bytes of events one session's current turn may hold for replay.
 *
 * Eight mebibytes, on top of the 200-event count cap. Whichever bites first
 * wins, and both have the same consequence, which is a consequence the contract
 * already defines: events that fall out of the ring are replayed from the
 * `EventLog`, and a client that has fallen past both takes a fresh snapshot.
 */
export const RING_BUFFER_MAX_BYTES = 8 * 1024 * 1024;

/**
 * Total bytes of events one session's log may hold.
 *
 * Thirty-two mebibytes, on top of the 5000-event count cap. Sized four times
 * the ring so the log still spans many turns of replay depth, and low enough
 * that a hundred idle sessions cannot quietly hold gigabytes.
 */
export const EVENT_LOG_MAX_BYTES = 32 * 1024 * 1024;

/**
 * What the guard leaves behind where an oversized string was.
 *
 * @param bytes - How much was dropped.
 */
function omissionMarker(bytes: number): string {
  return `[${bytes.toLocaleString('en-US')} bytes omitted — too large to deliver on the session stream]`;
}

/**
 * Measured sizes, keyed by event identity.
 *
 * The ring and the log hold the SAME event object and both need its size — on
 * append and again on every eviction — so measuring per call would stringify a
 * chatty turn's every token delta four times over. A `WeakMap` costs nothing
 * when the event is dropped and needs no invalidation, because a `SessionEvent`
 * is never mutated after the projector stamps it.
 */
const sizeByEvent = new WeakMap<SessionEvent, number>();

/**
 * The approximate wire size of one event, in bytes.
 *
 * `JSON.stringify` then a byte length, which is what actually goes out over
 * SSE. Approximate only in that it ignores the SSE framing around it, which is
 * a constant few dozen bytes. Memoized per event — see {@link sizeByEvent}.
 *
 * @param event - The event to measure.
 */
export function eventByteSize(event: SessionEvent): number {
  const cached = sizeByEvent.get(event);
  if (cached !== undefined) return cached;
  const size = Buffer.byteLength(JSON.stringify(event), 'utf8');
  sizeByEvent.set(event, size);
  return size;
}

/**
 * Return the event with any oversized string replaced by a stated omission, or
 * the event itself when nothing needed replacing.
 *
 * Structure-preserving: only string VALUES are rewritten, and only those past
 * {@link MAX_EVENT_STRING_BYTES}. Keys, numbers, booleans, the `type`
 * discriminator and every id survive untouched, so a guarded event still
 * projects, still pairs with its tool call, and still closes its turn.
 *
 * The common case allocates nothing — an event with no oversized string is
 * returned by reference, so this costs one traversal on the hot path.
 *
 * @param event - The event about to be stamped and streamed.
 */
export function guardEventSize(event: SessionEvent): SessionEvent {
  const guarded = guardValue(event);
  return (guarded ?? event) as SessionEvent;
}

/**
 * The value with oversized strings replaced, or `undefined` when it is already
 * within budget — the signal that lets an unchanged branch be returned by
 * reference rather than rebuilt.
 */
function guardValue(value: unknown): unknown | undefined {
  if (typeof value === 'string') {
    const bytes = Buffer.byteLength(value, 'utf8');
    return bytes > MAX_EVENT_STRING_BYTES ? omissionMarker(bytes) : undefined;
  }
  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((item) => {
      const guarded = guardValue(item);
      if (guarded === undefined) return item;
      changed = true;
      return guarded;
    });
    return changed ? next : undefined;
  }
  if (value !== null && typeof value === 'object') {
    let changed = false;
    const next: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const guarded = guardValue(item);
      if (guarded === undefined) {
        next[key] = item;
        continue;
      }
      changed = true;
      next[key] = guarded;
    }
    return changed ? next : undefined;
  }
  return undefined;
}
