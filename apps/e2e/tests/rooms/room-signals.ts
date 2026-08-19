import type { Page } from '@playwright/test';

/**
 * Put presence signals on a room's REAL live stream, from the test.
 *
 * ## Why this exists
 *
 * A room's presence line is fed by ephemeral `progress` signals the dispatcher
 * publishes while it holds a claim. Producing one for real needs an agent taking
 * a turn that lasts long enough to photograph — which on the cockpit leg means a
 * real model (money, and not deterministic), and on the test-mode leg means a
 * scenario, which is server-global state that `chat-mock.spec.ts` resets between
 * every one of its tests. Both routes buy fidelity with flake.
 *
 * So the stream stays real and only the signals are ours. The shim wraps
 * `window.WebSocket` for the room-events socket alone, leaves the server's own
 * frames untouched, and lets the test deliver extra ones onto the same socket.
 * Everything downstream is the shipped code: the frame decoder, the schema
 * validation that drops malformed frames, the store, the hook's timer, the
 * component. What this does NOT prove is that the server publishes — that is
 * pinned server-side, where the claim map is reachable
 * (`room-presence-claims.test.ts`).
 *
 * It wrapped `window.fetch` until the durable streams became WebSockets (ADR
 * 260805-041016), which is the sort of thing that breaks a test helper silently:
 * the tap simply never matched, and the spec failed saying the stream was never
 * open. Wrapping the constructor and dispatching a `message` event is the
 * equivalent move — a real socket delivers its `onmessage` through the same
 * dispatch, so nothing downstream can tell the difference.
 *
 * @module tests/rooms/room-signals
 */

/**
 * How long to let a room's live stream come up before giving up on it.
 *
 * The same ceiling every other room wait uses — a bound on a stall, not a delay
 * anything pays on the way through.
 */
const STREAM_OPEN_MS = 30_000;

/** One presence publish, exactly as `RoomSignalEventSchema` describes it. */
export interface PresenceSignal {
  /** The agent the indicator is about. */
  authorId: string;
  /**
   * Where it is in its work. `'held'` is the one that describes work that has
   * NOT started: this room's message is waiting on a turn the agent is running
   * in a different room that shares its checkout.
   */
  state: 'working' | 'working_late' | 'held' | 'done';
  /** The entry whose trigger it answers — with the author, the whole key. */
  entryId: string;
  /** ISO 8601 — when the work, or the wait, started. */
  since: string;
  /**
   * What the turn is doing right now, when the dispatcher has heard a tool call
   * for it. Structure only — the client owns the words (DOR-1351).
   */
  activity?: { toolName: string; target?: string };
  /**
   * What a `'held'` indicator is waiting behind, on that state and no other.
   *
   * An id and a boolean, exactly as the wire carries it: the reader resolves the
   * room's NAME against the rooms it can already see, so a synthetic frame
   * naming a room this page cannot see is how the "another conversation"
   * fallback is reached.
   */
  heldBehind?: { roomId: string; othersWaiting: boolean };
}

/**
 * Install the stream shim. Call before `page.goto`, like any init script.
 *
 * @param page - The page whose room stream to tap.
 */
export async function tapRoomStream(page: Page): Promise<void> {
  await tapStream(page, '__roomStream', '/rooms/[^/?#]+/events(\\?|$)');
}

/**
 * Install the same shim on the GLOBAL stream, which is where the sidebar reads.
 *
 * A different socket answering a different question: `/api/events` carries what
 * a reader who is not in a room needs to know about it, including the count of
 * agents working in it. Everything the room shim's doc says applies unchanged —
 * the bytes are the server's, only the extra frames are ours.
 *
 * @param page - The page whose global stream to tap.
 */
export async function tapGlobalStream(page: Page): Promise<void> {
  await tapStream(page, '__globalStream', '/api/events(\\?|$)');
}

/** Wrap `window.WebSocket` for one stream, exposing a pusher at `window[key]`. */
async function tapStream(page: Page, key: string, pattern: string): Promise<void> {
  await page.addInitScript(
    ([tapKey, urlPattern]) => {
      const inject = { push: null as ((frame: string) => void) | null };
      (window as unknown as Record<string, typeof inject>)[tapKey] = inject;
      const matches = new RegExp(urlPattern);

      const NativeWebSocket = window.WebSocket;
      const Wrapped = function (this: unknown, url: string | URL, protocols?: string | string[]) {
        const socket =
          protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        if (matches.test(String(url))) {
          // Deliver onto the SAME socket the app is reading. `dispatchEvent`
          // reaches the `onmessage` handler the transport assigned, so the frame
          // takes the identical path a server frame takes.
          const mine = (frame: string) => {
            socket.dispatchEvent(new MessageEvent('message', { data: frame }));
          };
          inject.push = mine;
          socket.addEventListener(
            'close',
            () => {
              // Only clear the slot if it is still OURS. The hook reconnects, and
              // a close for the old socket can land after the new one has already
              // claimed the slot — clearing unconditionally would then leave the
              // tap looking shut over a perfectly live stream, and `pushFrame`
              // would throw "the stream closed" at a reconnected room.
              if (inject.push === mine) inject.push = null;
            },
            { once: true }
          );
        }
        return socket;
      } as unknown as typeof WebSocket;
      Wrapped.prototype = NativeWebSocket.prototype;
      Object.assign(Wrapped, NativeWebSocket);
      window.WebSocket = Wrapped;
    },
    [key, pattern] as [string, string]
  );
}

/**
 * Publish one presence signal onto the open room's stream.
 *
 * **Waits for the stream to be open rather than requiring it to be.** A room
 * hydrates its history over REST and connects its stream separately, so "the
 * entries are on screen" does not mean "the socket is up" — it only usually
 * does, on an unloaded machine. This used to throw the moment the two arrived
 * in the other order, which made the presence spec pass or fail on how busy the
 * run was rather than on anything about presence. Waiting is what every other
 * assertion in this suite does.
 *
 * @param page - The page holding the stream, already tapped.
 * @param signal - What the dispatcher would have said.
 */
export async function publishPresence(page: Page, signal: PresenceSignal): Promise<void> {
  const event = {
    type: 'signal',
    signal: 'progress',
    authorId: signal.authorId,
    at: new Date().toISOString(),
    state: signal.state,
    entryId: signal.entryId,
    since: signal.since,
    ...(signal.activity ? { activity: signal.activity } : {}),
    ...(signal.heldBehind === undefined ? {} : { heldBehind: signal.heldBehind }),
  };
  await pushFrame(page, '__roomStream', 'signal', event);
}

/**
 * Say how many agents are working in a room, on the global stream.
 *
 * What the dispatcher broadcasts at every claim transition and again on its
 * ten-second tick — the sidebar's half of presence, which reaches a reader who
 * has no room open at all.
 *
 * @param page - The page holding the global stream, already tapped.
 * @param count.roomId - The room the dot belongs to.
 * @param count.working - How many agents are working in it. `0` clears the dot.
 */
export async function publishWorkingCount(
  page: Page,
  count: { roomId: string; working: number }
): Promise<void> {
  await pushFrame(page, '__globalStream', 'room_presence', count);
}

/**
 * Say that a session is mid-turn, fleet-wide, on the global stream.
 *
 * The other half of "who is working": the home surface's presence strip reads
 * ROOM claims for rooms whose streams are open and streaming SESSIONS for
 * everywhere else, and home excludes its own room — so on `/` the strip's rows
 * come from here (`use-presence-rows.ts`, `useWorkingSessions`).
 *
 * The `cwd` is load-bearing rather than decorative: the strip attributes a
 * session to an agent by its working directory, and a session whose runtime
 * reported none is a turn with nobody's name on it, which never becomes a row.
 * So pass a REGISTERED agent's directory or the strip will correctly ignore it.
 *
 * @param page - The page holding the global stream, already tapped.
 * @param session.sessionId - The session to mark as streaming.
 * @param session.cwd - Its working directory: a registered agent's path.
 */
export async function publishSessionStreaming(
  page: Page,
  session: { sessionId: string; cwd: string }
): Promise<void> {
  await pushFrame(page, '__globalStream', 'session_status', {
    type: 'session_status',
    sessionId: session.sessionId,
    cwd: session.cwd,
    status: {
      contextUsage: null,
      cost: null,
      usage: null,
      cacheStats: null,
      model: null,
      permissionMode: 'default',
      todoCounts: null,
      runningSubagentCount: 0,
      lifecycle: 'streaming',
      lastError: null,
    },
  });
}

/**
 * Put one frame onto a tapped stream, once it is open.
 *
 * **Waits for the stream to be open rather than requiring it to be.** A page
 * hydrates over REST and connects its streams separately, so "the entries are on
 * screen" does not mean "the socket is up" — it only usually does, on an
 * unloaded machine. This used to throw the moment the two arrived in the other
 * order, which made the presence spec pass or fail on how busy the run was
 * rather than on anything about presence.
 *
 * @param page - The page holding the stream.
 * @param key - Which tap to push onto.
 * @param eventName - The frame's event name.
 * @param data - The frame's payload.
 */
async function pushFrame(page: Page, key: string, eventName: string, data: unknown): Promise<void> {
  await page
    .waitForFunction(
      (tapKey) =>
        (window as unknown as Record<string, { push?: ((f: string) => void) | null } | undefined>)[
          tapKey
        ]?.push != null,
      key,
      { timeout: STREAM_OPEN_MS }
    )
    .catch(() => {
      // A bare Playwright timeout here names `waitForFunction` and an anonymous
      // predicate, which says nothing about which stream never came up. The
      // sentence is deliberately NOT the one the push below throws: never
      // opening and closing mid-flight are different failures, and reporting the
      // same words for both sends the reader to the wrong place.
      throw new Error(`The ${key} stream is not open yet — nothing to publish onto.`);
    });
  await page.evaluate(
    ([tapKey, frame]) => {
      const tap = (
        window as unknown as Record<string, { push?: ((f: string) => void) | null } | undefined>
      )[tapKey];
      if (!tap?.push) throw new Error('The stream closed before this frame could be sent.');
      tap.push(frame);
    },
    // A JSON stream frame, the WebSocket wire format — the same shape
    // `encodeStreamFrame` produces server-side.
    [key, JSON.stringify({ event: eventName, data })] as [string, string]
  );
}
