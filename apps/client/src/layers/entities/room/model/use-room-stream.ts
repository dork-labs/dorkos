/**
 * Bridge a room's durable SSE stream into the query cache (spec `rooms` §7).
 *
 * The connect is a RESUME, never cold: it opens only once `useRoomEntries` has
 * landed, and resumes from the highest `seq` that read produced. That closes the
 * window a cold connect would leave — an entry committed between the history
 * read and the subscription would otherwise be delivered in a snapshot frame
 * this stream deliberately skips, and so would never reach the reader. An empty
 * room resumes from `0`, which the server serves as "replay nothing, go live".
 *
 * A dropped stream is retried here, in the hook, rather than below it. The
 * `WSConnection` that carries the session stream's resilience speaks the wire
 * directly and cannot be reached through the Transport port, so wiring this to
 * it would leave embedded mode (Obsidian's `DirectTransport`, which has no HTTP
 * server) with the only unreliable room stream. The port stays contract-level —
 * one subscription, no retries, the same line `session-stream-methods.ts` draws
 * — and resilience sits above it, where both adapters inherit it.
 *
 * With one deliberate exception, in the other direction: DETECTING a dead
 * socket lives in the HTTP adapter's `subscribeRoom`, because the server's
 * heartbeat is an SSE comment the adapter drops. Up here a silent socket and a
 * quiet room are the same thing. The adapter turns silence into a throw; this
 * loop turns a throw into a reconnect.
 *
 * @module entities/room/model/use-room-stream
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { RoomEntry } from '@dorkos/shared/room-schemas';
import { isFatalStreamError, SSE_RESILIENCE } from '@/layers/shared/lib';
import { streamManager } from '@/layers/shared/lib/transport';
import { useTransport } from '@/layers/shared/model';
import { roomKeys } from '../api/query-keys';
import { mergeRoomReactions } from '../lib/reactions';
import { usePendingPostStore } from './pending-posts';
import { useRoomPresenceStore } from './use-room-presence';

/**
 * Insert an entry into a room's cached history, keeping it ordered by `seq` and
 * dropping a duplicate. A replayed entry is not an error — resuming from a
 * cursor the reader already holds is how a reconnect stays gap-free — so an
 * already-present `seq` is a no-op that preserves the cached array's identity.
 *
 * @param cached - The current cached history, oldest-first.
 * @param entry - The entry to merge in.
 * @internal Exported for testing.
 */
export function mergeRoomEntry(
  cached: readonly RoomEntry[] | undefined,
  entry: RoomEntry
): RoomEntry[] {
  const list = cached ?? [];
  if (list.some((held) => held.seq === entry.seq)) return list as RoomEntry[];
  // Entries almost always arrive in order, so check the tail before sorting.
  if (list.length === 0 || list[list.length - 1]!.seq < entry.seq) return [...list, entry];
  return [...list, entry].sort((a, b) => a.seq - b.seq);
}

/**
 * Retire the indicator of the agent a notice is ABOUT, where the notice means
 * that agent has stopped.
 *
 * The rule beside this one — an author's own entry clears that author's
 * indicators — cannot reach these, and the gap is why a room could sit drawing
 * "Kai is working · 6m" under a line saying Kai ran into a problem. A notice is
 * written by the SYSTEM author, so clearing on `entry.authorId` clears the
 * system's indicators, of which there are never any. `body.subjectAuthorId`
 * names the agent, and until now nothing read it.
 *
 * **Only `turn_failed`**, deliberately. It is the one code that means the work
 * has ended: the turn errored or never finished, and no `done` signal is coming
 * because the thing that would have published one is gone.
 *
 * Every other code is deliberately left alone, and each for its own reason:
 *
 * - `agent_busy` reads like a stop and is the opposite. The trigger was skipped
 *   because that agent's session was ALREADY being written to — so the agent is
 *   genuinely working, on the older message, and clearing its indicator would
 *   blank the one true thing on screen.
 * - `awaiting_approval` is the same trap in sharper form. The turn is very much
 *   alive; it is stopped on a person and will carry straight on when they
 *   answer, so the indicator is telling the truth and the notice is telling the
 *   reader what to do about it. Retiring it here would say the work had ended
 *   at the exact moment the room is asking somebody to keep it going.
 * - `cascade_stopped`, `budget_reached` and `agent_unavailable` describe a turn
 *   that was never started, so there is no indicator to retire. A bind failure
 *   is the same shape as the other two here: `claimTargets` catches it before a
 *   claim is ever taken, so nothing was ever published for this hook to clear.
 * - `halted` retires nothing here BECAUSE it does not need to: the halt drops
 *   every claim through the dispatcher, so a real `done` signal is already on
 *   its way for each one (`room-trigger.ts`'s `releaseClaim`). This is the one
 *   code where the server does the clearing, which is why it stays out of the
 *   list rather than being an oversight in it.
 *
 * @param roomId - The room the notice landed in.
 * @param entry - The entry that just arrived, of any kind.
 */
function clearNoticeSubject(roomId: string, entry: RoomEntry): void {
  if (entry.kind !== 'notice' || entry.body.notice !== 'turn_failed') return;
  const subject = entry.body.subjectAuthorId;
  if (subject === undefined) return;
  useRoomPresenceStore.getState().clearAuthor(roomId, subject);
}

/** The highest `seq` a room's cached history holds, or 0 when it is empty. */
function cursorFromCache(queryClient: QueryClient, roomId: string): number {
  const cached = queryClient.getQueryData<RoomEntry[]>(roomKeys.entries(roomId));
  return cached && cached.length > 0 ? cached[cached.length - 1]!.seq : 0;
}

/**
 * Full-jitter exponential backoff, the same curve `WSConnection` retries on.
 *
 * @param failures - Consecutive failed attempts, starting at 1.
 */
function backoffMs(failures: number): number {
  const ceiling = Math.min(
    SSE_RESILIENCE.BACKOFF_CAP_MS,
    SSE_RESILIENCE.BACKOFF_BASE_MS * 2 ** failures
  );
  return Math.random() * ceiling;
}

/**
 * How long a browser-raised wake-up waits for its siblings.
 *
 * A laptop coming out of sleep fires all three within a few milliseconds —
 * `online`, the tab coming forward, and the global stream reconnecting — and
 * acting on each is three teardowns and three reopens of one socket to reach
 * the state the first would have reached. Long enough to gather them, short
 * enough that nobody could see it.
 */
const WAKE_COALESCE_MS = 50;

/** Wait `ms`, or return early the moment `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    // An already-aborted signal never fires `abort` again, so it has to be read
    // rather than listened for — otherwise this waits out the full backoff.
    if (signal.aborted) return resolve();
    const settle = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', settle);
      resolve();
    };
    const timer = setTimeout(settle, ms);
    signal.addEventListener('abort', settle, { once: true });
  });
}

/** What the open room's live stream is doing. */
export interface RoomStreamState {
  /**
   * True once the stream has dropped more times in a row than
   * {@link SSE_RESILIENCE.DISCONNECTED_THRESHOLD} — so the room on screen is no
   * longer live, and everything a reader might infer from its silence is
   * unreliable. Nothing else reports this: the global stream keeps reconnecting
   * and re-badging the room in the sidebar, which would make a frozen room look
   * like a quiet one.
   *
   * **It is a statement about now, not a terminal state.** The loop keeps
   * retrying underneath it at the backoff cap, and clears it the moment a stream
   * is demonstrably alive again.
   *
   * **Latched once per OUTAGE, not once per failed attempt.** Since the loop no
   * longer stops, a per-attempt latch would re-clear the presence store every
   * thirty seconds for as long as a server stayed down, and would re-announce a
   * state the reader has already been told about.
   */
  stalled: boolean;
  /**
   * True when the room is not live AND will not become live on its own: the
   * server answered that this reader may not read it — deleted, signed out, or
   * no longer a member.
   *
   * It refines {@link RoomStreamState.stalled} rather than replacing it, so
   * everything that already stands down on a stalled room (reactions, the
   * notice) keeps working without knowing which of the two happened. Only the
   * words change, and they have to: "reconnecting" over a room that is never
   * coming back is a worse lie than the one the infinite retry fixed.
   */
  unavailable: boolean;
  /** Try again from the newest entry the reader holds. */
  retry: () => void;
}

/**
 * Subscribe to a room's live entries and reflect them into the cache.
 *
 * Reconnects on its own: when the stream ends or throws, the cursor is
 * recomputed from the cache — so the resume is gap-free however many entries
 * were missed — and the subscription reopens after a jittered backoff. A stream
 * that stayed up longer than the stability window is forgiven its earlier
 * failures, so a server that restarts nightly never spends the budget.
 *
 * **It never stops trying, and that is the fix.** Retrying stopped at
 * {@link SSE_RESILIENCE.DISCONNECTED_THRESHOLD} — five attempts over roughly
 * seven seconds — after which the room was frozen for as long as the tab stayed
 * open, while the global `/api/events` stream beside it reconnected forever. A
 * brief lift ended a room's day. The threshold now decides only when to SAY the
 * room has gone quiet; the loop carries on at the backoff cap underneath, and
 * clears that notice the moment a stream proves itself alive.
 *
 * Three things wake it early rather than waiting out a backoff that may be at
 * its 30s cap, because all three mean the network just changed underneath it:
 * the browser going back online, the global stream recovering, and a tab coming
 * back to the foreground after long enough that its connections may have been
 * culled.
 *
 * @param roomId - The room to follow, or `null` when nothing is selected.
 * @param hydrated - Whether the room's history has loaded. The stream waits for
 *   it, because the cursor it resumes from is that read's high-water mark.
 * @returns Whether the room has gone quiet, and a way to ask it to try now.
 */
export function useRoomStream(roomId: string | null, hydrated: boolean): RoomStreamState {
  const transport = useTransport();
  const queryClient = useQueryClient();
  // Which room gave up, not whether one did: switching rooms must not carry the
  // dead-stream notice across to a room whose stream is perfectly alive.
  const [stalledRoomId, setStalledRoomId] = useState<string | null>(null);
  // Which room the server has said this reader may not have — see
  // `isFatalStreamStatus`. Held per room for the same reason the stall is.
  const [goneRoomId, setGoneRoomId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  /**
   * Whether the subscription loop is between streams RIGHT NOW — in a backoff
   * wait, rather than holding an open subscription.
   *
   * Read by the wake-ups below, so a tab switch over a perfectly healthy room
   * does not tear down a live socket to open an identical one. It is cleared at
   * the top of every attempt rather than only once a stream has proved itself:
   * proof takes up to the stability window, and treating those ten seconds as
   * "between streams" made a brief alt-tab tear down a stream that was fine.
   */
  const betweenStreamsRef = useRef(false);

  // Re-running the effect is the whole of a retry: the cycle below clears the
  // stall itself, so there is nothing to reset here.
  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  /**
   * A retry asked for by the browser rather than by a person.
   *
   * Coalesced, because a laptop waking up fires all three of these within a few
   * milliseconds of each other — `online`, the tab coming forward, and the
   * global stream reconnecting — and three retries in three ticks is three
   * teardowns and three reopens of the same socket to reach the state the first
   * one already reached. A person pressing Reconnect gets {@link retry}, which
   * is immediate: they are watching, and a delay they can see is worse than a
   * redundant connect they cannot.
   */
  const wakeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wake = useCallback(() => {
    if (wakeTimer.current !== null) return;
    wakeTimer.current = setTimeout(() => {
      wakeTimer.current = null;
      setAttempt((n) => n + 1);
    }, WAKE_COALESCE_MS);
  }, []);

  // The three wake-ups. Each is a fact about the network rather than a guess,
  // and each is cheap: a retry re-opens from the cursor the reader already
  // holds, so the worst case of an unnecessary one is a redundant resume.
  useEffect(() => {
    if (roomId === null) return;

    // `online` means the machine had no network and now does, so whatever
    // socket was open is dead by definition — no health check needed.
    const onOnline = () => wake();

    // A tab that was in the background long enough for a browser to cull its
    // connections comes back to a socket that may be dead without anything
    // having noticed: the adapter's own detection is a heartbeat watchdog, so
    // it would take up to another 45s to find out. Short switches are left
    // alone — the stream is almost certainly fine, and reopening it on every
    // alt-tab would be worse than the problem.
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') {
        hiddenAt = Date.now();
        return;
      }
      const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
      hiddenAt = null;
      if (betweenStreamsRef.current || hiddenFor >= SSE_RESILIENCE.VISIBILITY_GRACE_MS) wake();
    };

    // The global stream recovering says the server is reachable again. It is
    // the signal that used to be missing entirely: `/api/events` reconnected
    // forever and re-badged this very room in the sidebar while the room on
    // screen sat dead, which is what made a frozen room look like a quiet one.
    let previous = streamManager.getListConnectionState();
    const unsubscribe = streamManager.subscribeListConnectionState((state) => {
      const recovered = state === 'connected' && previous === 'reconnecting';
      previous = state;
      if (recovered) wake();
    });

    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisibility);
      unsubscribe();
      if (wakeTimer.current !== null) {
        clearTimeout(wakeTimer.current);
        wakeTimer.current = null;
      }
    };
  }, [roomId, wake]);

  useEffect(() => {
    if (roomId === null || !hydrated) return;

    const controller = new AbortController();

    void (async () => {
      // A fresh subscription cycle is starting, so no room is dead right now.
      // Without this the notice is sticky: leaving a stalled room and coming
      // back opens a healthy stream under a banner still saying nothing is
      // coming through. Clearing on the way IN also covers the retry button and
      // a re-hydrate, which are the only other ways a cycle begins.
      setStalledRoomId(null);
      setGoneRoomId(null);
      betweenStreamsRef.current = false;
      let failures = 0;
      // Said once per outage, not once per failed attempt: the loop no longer
      // stops, so without this the room would clear its presence store every
      // thirty seconds forever.
      let declared = false;

      /** This stream has proved itself; forget the outage that preceded it. */
      const declareHealthy = () => {
        failures = 0;
        betweenStreamsRef.current = false;
        if (!declared) return;
        declared = false;
        setStalledRoomId((held) => (held === roomId ? null : held));
      };

      while (!controller.signal.aborted) {
        const openedAt = Date.now();
        // The wait is over and a subscription is about to exist. Cleared HERE
        // rather than once the stream has proved itself, because proof takes up
        // to the stability window and a live-but-unproven stream is not one the
        // wake-ups should be tearing down.
        betweenStreamsRef.current = false;
        // A room can be healthy and completely silent, so "an event arrived" is
        // not the only proof of life — a stream still open after the stability
        // window is the other, and it is the one that takes the notice back down
        // over a quiet room whose server has come back.
        const stable = setTimeout(declareHealthy, SSE_RESILIENCE.STABILITY_WINDOW_MS);
        try {
          const stream = transport.subscribeRoom(
            roomId,
            cursorFromCache(queryClient, roomId),
            controller.signal
          );
          for await (const event of stream) {
            if (controller.signal.aborted) return;
            // Anything arriving is proof the socket is alive, which is the fast
            // path out of a stall — a busy room recovers on its first message
            // rather than ten seconds later.
            declareHealthy();
            // Signals (typing, presence) are live-only and carry no `seq`, so
            // they never enter the history — they go to the presence store,
            // which expires them rather than keeping them.
            if (event.type === 'signal') {
              useRoomPresenceStore.getState().observe(roomId, event);
              continue;
            }
            // Reactions are durable state ON an entry rather than a place in
            // the log: the event carries the entry's WHOLE set and no `seq`, so
            // it is written onto the entry the cache already holds and never
            // moves the cursor. A resume re-sends one of these per entry in the
            // trailing window — including entries with no pills at all, which is
            // how a removal made while this reader was away gets corrected.
            if (event.type === 'reaction') {
              queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(roomId), (cached) =>
                mergeRoomReactions(cached, event.entryId, event.reactions)
              );
              continue;
            }
            // An author's own entry retires that author's indicators here. It
            // has to happen on the way in, beside the merge: the entry replays
            // on a reconnect and the `done` beside it does not, so a client that
            // waited for the release would draw "working" under an answer that
            // is already on screen (`use-room-presence` explains the rest).
            useRoomPresenceStore.getState().clearAuthor(roomId, event.entry.authorId);
            // …and the rule above cannot reach a notice's subject, because a
            // notice is written by the SYSTEM author and is ABOUT an agent.
            clearNoticeSubject(roomId, event.entry);
            // The echo of something this reader sent retires the row that has
            // been holding those words on screen since they were typed. Keyed on
            // the server's own id, so two sends of "ok" retire in the order they
            // were accepted rather than whichever row matched the text first.
            usePendingPostStore.getState().settle(roomId, event.entry.id);
            // Only the history. The same post also fans out globally as
            // `room_activity`, which `useRoomListStream` turns into the list
            // refresh — so refreshing here too would just do it twice.
            queryClient.setQueryData<RoomEntry[]>(roomKeys.entries(roomId), (cached) =>
              mergeRoomEntry(cached, event.entry)
            );
          }
        } catch (err) {
          if (controller.signal.aborted) return;
          console.warn('[rooms] live stream dropped', { roomId, err });
          // The server ANSWERED, and its answer was that this reader may not
          // read this room — it is gone, or they are signed out, or they are no
          // longer a member. Retrying that forever draws "reconnecting" over a
          // room that is never coming back, which is a worse lie than the one
          // the infinite retry was introduced to fix.
          if (isFatalStreamError(err)) {
            useRoomPresenceStore.getState().clearRoom(roomId);
            setGoneRoomId(roomId);
            setStalledRoomId(roomId);
            clearTimeout(stable);
            return;
          }
        } finally {
          clearTimeout(stable);
        }
        if (controller.signal.aborted) return;

        // A stream that ran for the stability window did its job; whatever went
        // wrong after that is a fresh incident, not a continuing one.
        if (Date.now() - openedAt >= SSE_RESILIENCE.STABILITY_WINDOW_MS) failures = 0;
        failures += 1;
        betweenStreamsRef.current = true;
        if (failures >= SSE_RESILIENCE.DISCONNECTED_THRESHOLD && !declared) {
          // Whatever was working is now unknowable: the releases would have come
          // down the stream that just died. A frozen "· 42s" under a banner
          // saying nothing is coming through is the lingering-dots lie.
          useRoomPresenceStore.getState().clearRoom(roomId);
          setStalledRoomId(roomId);
          declared = true;
        }
        // And then round again. The backoff curve caps at
        // `SSE_RESILIENCE.BACKOFF_CAP_MS`, so a room nobody can reach costs one
        // request every thirty seconds — the same standing cost the global
        // stream has always paid, and the price of a room that comes back on
        // its own when the network does.
        await wait(backoffMs(failures), controller.signal);
      }
    })();

    return () => controller.abort();
  }, [roomId, hydrated, transport, queryClient, attempt]);

  return {
    stalled: stalledRoomId !== null && stalledRoomId === roomId,
    unavailable: goneRoomId !== null && goneRoomId === roomId,
    retry,
  };
}
