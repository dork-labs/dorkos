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
 * `window.fetch` for the room-events request alone, pipes the server's own bytes
 * through untouched, and lets the test enqueue extra frames into the same
 * stream. Everything downstream of the socket is the shipped code: the SSE
 * parser, the schema validation that drops malformed frames, the store, the
 * hook's timer, the component. What this does NOT prove is that the server
 * publishes — that is pinned server-side, where the claim map is reachable
 * (`room-presence-claims.test.ts`).
 *
 * The transport speaks `fetch` rather than `EventSource`, which is what makes
 * this possible at all (`transport/room-methods.ts`).
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
  /** Where it is in its work. */
  state: 'working' | 'working_late' | 'done';
  /** The entry whose trigger it answers — with the author, the whole key. */
  entryId: string;
  /** ISO 8601 — when the work started. The elapsed time is derived from it. */
  since: string;
}

/**
 * Install the stream shim. Call before `page.goto`, like any init script.
 *
 * @param page - The page whose room stream to tap.
 */
export async function tapRoomStream(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const inject = { push: null as ((frame: string) => void) | null };
    (window as unknown as { __roomStream: typeof inject }).__roomStream = inject;

    const passThrough = window.fetch.bind(window);
    window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (!/\/rooms\/[^/?#]+\/events(\?|$)/.test(url)) return passThrough(input, init);

      const upstream = await passThrough(input, init);
      if (!upstream.ok || !upstream.body) return upstream;
      const body = upstream.body;
      const encoder = new TextEncoder();

      const merged = new ReadableStream<Uint8Array>({
        start(controller) {
          inject.push = (frame: string) => controller.enqueue(encoder.encode(frame));
          void (async () => {
            const reader = body.getReader();
            try {
              for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                controller.enqueue(value);
              }
            } catch {
              // The socket ended, which is the caller's business, not ours.
            }
            try {
              controller.close();
            } catch {
              // Already closed by an abort on the way out.
            }
          })();
        },
      });

      // A fresh header set rather than the upstream's: the body handed back has
      // already been decoded once, so replaying a `content-encoding` would ask
      // the browser to decode it again.
      return new Response(merged, {
        status: upstream.status,
        statusText: upstream.statusText,
        headers: { 'content-type': 'text/event-stream' },
      });
    };
  });
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
  };
  await page
    .waitForFunction(
      () =>
        (window as unknown as { __roomStream?: { push: ((f: string) => void) | null } })
          .__roomStream?.push != null,
      undefined,
      { timeout: STREAM_OPEN_MS }
    )
    .catch(() => {
      // The same sentence the publish below would have thrown. A bare Playwright
      // timeout here names `waitForFunction` and an anonymous predicate, which
      // says nothing about which room never came up.
      throw new Error('The room stream is not open yet — nothing to publish onto.');
    });
  await page.evaluate(
    (frame) => {
      const tap = (window as unknown as { __roomStream?: { push: ((f: string) => void) | null } })
        .__roomStream;
      if (!tap?.push) throw new Error('The room stream is not open yet — nothing to publish onto.');
      tap.push(frame);
    },
    `event: signal\ndata: ${JSON.stringify(event)}\n\n`
  );
}
