/**
 * Per-session "where I left off" cursor for the message list's unread rule.
 *
 * The cursor lives on the server (`read_cursors`, `thread_kind: 'session'` —
 * team-room-home §D4, ADR 260808-140956), which is what makes the rule agree on
 * every screen this person reads from. It used to live in this browser's
 * `localStorage`, which is exactly why two devices disagreed about what was new.
 *
 * It sits in the neutral slice because the one list that reads it is
 * `Conversation.Timeline`, which draws a session and a channel from the same
 * code. What it reads is still a SESSION cursor — the room's own rule is placed
 * against the `(member, room)` cursor its roster carries — so the two surfaces
 * arrive at the same rule from different stores, which is why the timeline takes
 * the placement as input rather than resolving it.
 *
 * @module features/conversation/model/use-unread-cursor
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReadCursor } from '@dorkos/shared/read-cursor-schemas';
import { unreadPlacement } from '@/layers/shared/lib';
import { useEventSubscription, useTransport } from '@/layers/shared/model';

/**
 * The retired `localStorage` watermark's key prefix.
 *
 * Kept only to DELETE with. The cursor moved to the server, so a leftover key is
 * dead weight in a store the operator never asked to fill — see
 * {@link purgeLegacyWatermarks}. Once a release or two has passed and no browser
 * plausibly still holds one, this constant and that function go with it.
 */
const LEGACY_CURSOR_STORAGE_PREFIX = 'dorkos:chat:last-seen:';

/**
 * Remove every retired watermark key.
 *
 * Not carried over into the server cursor, deliberately: a watermark is cheap to
 * lose (at worst one rule is drawn from further back than it was), while a
 * carry-over reads a number one browser wrote about itself and publishes it as
 * this person's position on every device — which is how one stale tab un-reads a
 * conversation everywhere. Sweeping the whole prefix rather than the open
 * session's key means a browser that never re-opens an old session still ends up
 * clean.
 *
 * Run on every session open rather than once behind a module-level flag: the
 * loop is over the handful of keys a cockpit stores and finds nothing at all
 * after the first sweep, which is cheaper than one more piece of process-wide
 * state to reason about.
 *
 * Storage can throw outright (Safari private mode, a host that disables it), and
 * tidying up is never a reason to fail a render.
 */
function purgeLegacyWatermarks(): void {
  try {
    const stale: string[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key?.startsWith(LEGACY_CURSOR_STORAGE_PREFIX)) stale.push(key);
    }
    for (const key of stale) window.localStorage.removeItem(key);
  } catch {
    // Best-effort. A key we cannot reach is a key nothing reads either.
  }
}

/**
 * The shape {@link useUnreadCursor} needs of a message.
 *
 * `_streaming` is the client-only tag on the at-most-two rows the server has not
 * confirmed: the optimistic user bubble and the in-progress assistant one
 * (`model/stream/project-session-turn`). They are rendered but never counted —
 * see {@link canonicalCount}.
 */
interface CountableMessage {
  id: string;
  _streaming?: boolean;
}

/**
 * How many messages of this transcript the SERVER would count.
 *
 * The two client-only rows are appended to the end of the rendered list while a
 * turn is in flight, so counting them would store a position for messages that
 * do not exist yet — and the reconcile that replaces them with the real ones
 * would leave the cursor a row or two ahead of the transcript, marking unread
 * messages read. Counting only what the transcript itself holds keeps the
 * position meaning the same thing on every screen.
 *
 * @param messages - The rendered transcript, oldest first.
 */
function canonicalCount(messages: readonly CountableMessage[]): number {
  let count = 0;
  for (const message of messages) {
    if (message._streaming !== true) count++;
  }
  return count;
}

/** What {@link useUnreadCursor} hands back to the list. */
export interface UnreadCursor {
  /**
   * Newest message the reader had already seen when this view opened, or null
   * when no message here is the one to place against — nothing read yet, caught
   * up, or {@link UnreadCursor.unreadFromStart} instead.
   *
   * Frozen for the lifetime of the view: it deliberately does NOT chase messages
   * that arrive while the reader is here, so the rule stays put under them the
   * way Slack's does. The one thing that moves it is the same person reading on
   * another device — see the `read_cursor` subscription below.
   */
  lastSeenMessageId: string | null;
  /**
   * Everything on screen is unread, so the rule goes above the first message.
   *
   * Distinct from a null {@link UnreadCursor.lastSeenMessageId}, which is "draw
   * nothing" — the same distinction a room draws, from the same rule.
   */
  unreadFromStart: boolean;
  /**
   * Record the whole current transcript as seen. Call while the list is pinned
   * to the bottom.
   */
  markSeen: () => void;
  /**
   * Whether the stored cursor has been read back yet (or has failed to be).
   *
   * The caller must not decide where to LAND until this is true: before the
   * answer arrives there is no rule to land on, and a list that has already
   * scrolled to the end has consumed the rule it would have drawn.
   */
  isHydrated: boolean;
}

/** One session's cursor as this view holds it. */
interface CursorState {
  /** The session it belongs to — the guard against a late answer landing on the next session. */
  sessionId: string;
  /** How many messages had been seen, or null for never-read / not-yet-known. */
  lastReadSeq: number | null;
  /** Whether the read has settled, successfully or not. */
  hydrated: boolean;
}

/** The fields this hook reads off a `read_cursor` broadcast. */
interface SessionCursorMoved {
  userId: string;
  threadKind: string;
  threadId: string;
  lastReadSeq: number;
}

/**
 * Does this `read_cursor` broadcast carry the fields this hook reads?
 *
 * The payload arrives as `unknown` — the fan-out is a string-keyed channel and
 * nothing types the two ends together — so it is checked rather than trusted. A
 * malformed event is dropped silently: this moves an unread rule, which is not
 * worth a console the operator reads past.
 */
function isSessionCursorMoved(payload: unknown): payload is SessionCursorMoved {
  if (typeof payload !== 'object' || payload === null) return false;
  const { userId, threadKind, threadId, lastReadSeq } = payload as Record<string, unknown>;
  return (
    typeof userId === 'string' &&
    typeof threadKind === 'string' &&
    typeof threadId === 'string' &&
    typeof lastReadSeq === 'number' &&
    Number.isInteger(lastReadSeq)
  );
}

/**
 * Track where the reader left off in a session.
 *
 * **The cursor counts messages.** `4` means "the fourth message of this
 * transcript and everything before it", so the rule goes immediately before the
 * fifth. It is deliberately NOT the session stream's SSE `seq`: that number is
 * stamped on stream EVENTS, while a session's completed history is read back
 * from the runtime's transcript (JSONL for claude-code), whose messages carry no
 * seq at all — so an event-space cursor could never say WHICH message a reader
 * opening a session cold left off at, which is the one thing this rule needs to
 * know. Counting messages is the same shape a room cursor has (a position in the
 * thread, compared as an integer), and {@link unreadPlacement} then applies the
 * one set of placement rules to both.
 *
 * **What the position is worth, honestly.** Two screens agree as long as they
 * render the same transcript, which is the ordinary case: the count comes from
 * the server's own history rows and never from the client-only rows a turn in
 * flight adds ({@link canonicalCount}). What can shift it is a reload whose
 * history came back with a row or two the last one did not have — a compaction
 * boundary, a local command's echo — which lands the rule one or two messages
 * EARLY. That is a couple of already-read messages under the line, not a missed
 * one, and the next {@link UnreadCursor.markSeen} clears it. A cursor that ends
 * up ABOVE the transcript (history trimmed below it) is clamped to the end and
 * draws no rule at all, which is right: what was trimmed away had been seen.
 *
 * Reads the stored cursor once per session and returns it unchanged while the
 * view is open. Writing is entirely the caller's call: {@link
 * UnreadCursor.markSeen} while the list is pinned to the bottom.
 *
 * There is deliberately NO write on unmount or session change. `markSeen`
 * re-identifies whenever the transcript grows, so a reader watching a live
 * conversation has already recorded every message that landed — the watching
 * case is covered. A leave-write would only ever consume an unread rule the
 * reader never actually looked at.
 *
 * That protection is only half the job, and the other half is the caller's:
 * whatever decides "pinned to the bottom" must not answer yes before the list
 * has real scroll geometry. `MessageList` gates its `markSeen` call on a
 * measured commit for exactly this reason — see the `measured` flag there. Open
 * a session with unread messages, scroll nowhere, and the cursor must still hold
 * the position it held when the view opened.
 *
 * @param sessionId - Session whose cursor to track.
 * @param messages - The rendered transcript, oldest first.
 */
export function useUnreadCursor(
  sessionId: string,
  messages: readonly CountableMessage[]
): UnreadCursor {
  const transport = useTransport();

  // Read once per session and hold it. Re-reading on any render would let a
  // write made while pinned move the rule out from under the reader. This is
  // React's documented "adjust state when a prop changes" pattern.
  const [cursor, setCursor] = useState<CursorState>(() => ({
    sessionId,
    lastReadSeq: null,
    hydrated: false,
  }));
  if (cursor.sessionId !== sessionId) {
    setCursor({ sessionId, lastReadSeq: null, hydrated: false });
  }

  /**
   * The highest position this client already knows about: what it read back,
   * what it has asked the server to store, and what another device told it.
   * Anything at or below is not news — which is what stops this view's own
   * writes from echoing back off the broadcast and clearing the rule under the
   * reader who is still looking at it.
   */
  const knownSeqRef = useRef(0);
  /**
   * The position waiting to be written, WITH the session it belongs to.
   *
   * The session is part of the value rather than of the writer, because the two
   * can disagree: `MessageList` is not remounted when the operator switches
   * conversation (there is no `key={sessionId}`), so a write still in flight for
   * one session outlives the view of it. Queueing a bare number let the drain
   * loop pick up the NEXT session's position and write it onto the previous
   * session's cursor — silently marking a conversation nobody had read as fully
   * read.
   */
  const pendingRef = useRef<{ sessionId: string; seq: number } | null>(null);
  /** Whether a write is in flight — the queue coalesces behind it. */
  const writingRef = useRef(false);
  /** Set after a refused write; this view then stops asking. */
  const writesStoppedRef = useRef(false);
  /** The session this view is showing NOW, readable from an async drain. */
  const activeSessionRef = useRef(sessionId);
  /**
   * This person's own user id, learned from the route's own answers.
   *
   * The route only ever reads or writes the CALLER's cursor, so whatever
   * `userId` comes back is ours by construction — no second "who am I" request,
   * and no client-held identity to go stale.
   */
  const selfUserIdRef = useRef<string | null>(null);

  const seenCount = canonicalCount(messages);

  useEffect(() => {
    purgeLegacyWatermarks();

    let cancelled = false;
    // Every one of these is per-session state, so every one is reset together
    // when the view switches. `writingRef` included: a drain still awaiting a
    // response belongs to the session that has just been left, and leaving the
    // flag set would let it hold this session's queue shut.
    activeSessionRef.current = sessionId;
    knownSeqRef.current = 0;
    pendingRef.current = null;
    writingRef.current = false;
    writesStoppedRef.current = false;

    void (async () => {
      let stored: ReadCursor | null = null;
      try {
        stored = await transport.getReadCursor('session', sessionId);
      } catch {
        // Read state is a nicety; a conversation that cannot report it still
        // renders. Settling anyway is what lets the list land, instead of
        // waiting forever for an answer that is not coming.
      }
      if (cancelled) return;
      if (stored) {
        knownSeqRef.current = stored.lastReadSeq;
        selfUserIdRef.current = stored.userId;
      }
      setCursor({ sessionId, lastReadSeq: stored?.lastReadSeq ?? null, hydrated: true });
    })();

    return () => {
      cancelled = true;
    };
  }, [transport, sessionId]);

  /**
   * Write the queued position, one request at a time.
   *
   * Coalescing behind the in-flight write IS the debounce, and a better one than
   * a timer: a burst of messages landing while the reader is pinned produces one
   * request plus one more for wherever the transcript ended up, and the cursor is
   * never left behind by a timer that had not fired yet. Superseded values are
   * dropped rather than queued, because only the last one means anything.
   *
   * `knownSeqRef` is raised BEFORE the request rather than after, so the
   * broadcast this write causes cannot beat its own HTTP response back to this
   * tab and be mistaken for another device's — and put back if the write is
   * refused, so a genuine broadcast at that position is still news afterwards.
   *
   * A queued position for a session this view has LEFT is abandoned rather than
   * written. It cannot be the current session's business, and the reader has
   * already moved on from the one it names.
   */
  const drainWrites = useCallback(async () => {
    if (writingRef.current) return;
    writingRef.current = true;
    try {
      for (;;) {
        const queued = pendingRef.current;
        if (queued === null) break;
        pendingRef.current = null;
        if (queued.sessionId !== activeSessionRef.current) continue;
        if (writesStoppedRef.current) break;

        const knownBefore = knownSeqRef.current;
        knownSeqRef.current = Math.max(knownBefore, queued.seq);
        try {
          const written = await transport.setReadCursor('session', queued.sessionId, queued.seq);
          selfUserIdRef.current = written.userId ?? selfUserIdRef.current;
        } catch {
          // Nothing was stored, so nothing about this position is known — put
          // the mark back, or a broadcast carrying that very position would be
          // dropped as "our own echo" for as long as this view is open.
          knownSeqRef.current = knownBefore;
          // A refusal is structural rather than transient: a caller the server
          // does not consider a person, or a store that cannot hold this at all.
          // Retrying on every message the transcript grows by would be a request
          // per message, forever. Scoped to the session that was refused: a
          // failure for a conversation the reader has already left must not
          // silence the one they are looking at now.
          if (queued.sessionId === activeSessionRef.current) writesStoppedRef.current = true;
          break;
        }
      }
    } finally {
      writingRef.current = false;
    }
  }, [transport]);

  const markSeen = useCallback(() => {
    if (!cursor.hydrated || writesStoppedRef.current) return;
    if (seenCount <= knownSeqRef.current) return;
    pendingRef.current = { sessionId, seq: seenCount };
    void drainWrites();
  }, [cursor.hydrated, sessionId, seenCount, drainWrites]);

  // The same person, reading on another device. Their cursor moved there, so the
  // rule goes out here — on the event, not the next time this view is opened.
  useEventSubscription('read_cursor', (payload) => {
    if (!isSessionCursorMoved(payload)) return;
    if (payload.threadKind !== 'session' || payload.threadId !== sessionId) return;
    // Whose cursor is this? Answered strictly once the route has told us who we
    // are, and by the install's shape until then: ADR 260727-184933 D6 keeps an
    // install single-human, so every `read_cursor` on this stream is this
    // reader's own. The day an install holds two people, this line is the one
    // that changes — `selfUserIdRef` is already the filter, it just has to be
    // populated before the first event rather than by the first answer.
    const self = selfUserIdRef.current;
    if (self !== null && payload.userId !== self) return;
    // Not news: our own write echoing back, or an event arriving behind a
    // fresher one. The cursor only ever moves forward.
    if (payload.lastReadSeq <= knownSeqRef.current) return;
    knownSeqRef.current = payload.lastReadSeq;
    setCursor({ sessionId, lastReadSeq: payload.lastReadSeq, hydrated: true });
  });

  // The rule's position, from the same function a room uses, over the same shape
  // of input: the canonical messages numbered from one.
  //
  // CLAMPED to the end of the transcript first, which is the one thing a session
  // answers differently from a room. A room whose cursor sits above everything
  // loaded has paged past it, so everything on screen is unread; a session's
  // history is loaded whole, so a cursor above it means the transcript has been
  // trimmed BELOW the cursor — and what was trimmed away had been read. Clamping
  // says so, and it is also what keeps the placement from anchoring on a message
  // that is not there.
  const positions = useMemo(
    () =>
      messages
        .filter((message) => message._streaming !== true)
        .map((message, index) => ({ id: message.id, seq: index + 1 })),
    [messages]
  );
  const storedSeq = cursor.lastReadSeq;
  const placement = unreadPlacement(
    positions,
    storedSeq === null ? null : Math.min(storedSeq, seenCount)
  );

  return {
    lastSeenMessageId: placement.lastSeenId,
    unreadFromStart: placement.fromStart,
    markSeen,
    isHydrated: cursor.hydrated,
  };
}
