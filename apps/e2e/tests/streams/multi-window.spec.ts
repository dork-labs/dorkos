import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';

/**
 * Several cockpit windows stay responsive (DOR-927).
 *
 * The bug this guards: every window parks durable streams, and while those were
 * Server-Sent Events each one held a socket out of the ~6 a browser allows per
 * origin **per profile**. Two streams a window meant the THIRD window took the
 * last socket, after which every request to that origin queued forever —
 * including the fourth window's own HTML. The whole app stopped responding, and
 * the symptoms (frozen activity dots, turns that looked stuck, reloads that
 * never finished) each read like a different bug.
 *
 * The suite had no multi-window test at all, which is why this shipped.
 *
 * ## Four ways to write this test so it can never fail
 *
 * All four were live traps here — the first draft of this file hit three of them
 * and passed against the unfixed code. They are named rather than left to be
 * rediscovered, and `apps/e2e/GOTCHAS.md` carries the same list:
 *
 * 1. **`browser.newContext()` per window.** Separate contexts get separate
 *    socket pools, so the budget is never shared. Real windows share a profile,
 *    so this uses ONE context and `context.newPage()`.
 * 2. **`page.request.get()` or the `request` fixture for the probe.** Those run
 *    in Node and bypass the browser's pool entirely. The probe must run INSIDE
 *    the page, via `page.evaluate(() => fetch(...))`.
 * 3. **Windows on the SAME session id.** The stream manager attaches one stream
 *    for the session, so N windows on one id park the same number of streams as
 *    one does. Each window gets its own id.
 * 4. **Windows with no `dir`.** A `/session` page without a working directory
 *    never attaches a session stream at all — it renders the welcome state — so
 *    each window parks only the global stream and four windows never reach the
 *    budget. This seeds a real agent and opens every window against it.
 */

/** Windows to open. Four is past the old wall of three, with margin. */
const WINDOW_COUNT = 4;

/**
 * Ceiling for the in-page probe.
 *
 * Coarse on purpose: this is not a latency benchmark, it is the difference
 * between "answered" and "queued behind a stream that never ends". The unfixed
 * code did not answer at all; a healthy one answers in single-digit ms, so
 * anything under two seconds discriminates without being flaky on a loaded CI
 * box.
 */
const PROBE_CEILING_MS = 2000;

/** How long to let each window settle so its streams are actually connected. */
const SETTLE_MS = 2500;

/**
 * Record every durable stream a page holds open, whatever protocol it uses.
 *
 * Protocol-agnostic on purpose. Counting only WebSockets would report zero on
 * an SSE build and make the "streams really connected" guard fail for the wrong
 * reason; counting only parked requests would report zero once they became
 * sockets. Either way the count is what stops "everything was fast" being
 * vacuous — a misconfigured dev proxy produced exactly that while this was
 * being written, with no stream connected and every probe green.
 */
const COUNT_STREAMS = `
  window.__dorkStreams = [];
  const track = (path) => {
    if (!/\\/api\\/(events|sessions\\/[^/]+\\/events|rooms\\/[^/]+\\/events)$/.test(path)) return null;
    window.__dorkStreams.push(path);
    return () => {
      const at = window.__dorkStreams.indexOf(path);
      if (at >= 0) window.__dorkStreams.splice(at, 1);
    };
  };

  const NativeWebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    const socket = protocols === undefined
      ? new NativeWebSocket(url)
      : new NativeWebSocket(url, protocols);
    const drop = track(String(url).replace(/^wss?:\\/\\/[^/]+/, '').split('?')[0]);
    if (drop) socket.addEventListener('close', drop, { once: true });
    return socket;
  };
  window.WebSocket.prototype = NativeWebSocket.prototype;
  Object.assign(window.WebSocket, NativeWebSocket);

  const nativeFetch = window.fetch;
  window.fetch = function (input, init) {
    const raw = typeof input === 'string' ? input : (input && input.url) || '';
    const drop = track(String(raw).replace(/^https?:\\/\\/[^/]+/, '').split('?')[0]);
    const result = nativeFetch.call(this, input, init);
    if (drop) {
      // An SSE stream's promise resolves at the headers; it is the BODY that
      // stays parked, so the release is hung off the body finishing.
      result.then(
        (response) => {
          const body = response.clone().body;
          if (!body) return drop();
          const reader = body.getReader();
          const pump = () => reader.read().then((r) => (r.done ? drop() : pump()), drop);
          pump();
        },
        drop
      );
    }
    return result;
  };
`;

/** Time `GET /api/health` from INSIDE the page (see trap 2). */
function probeFromPage(page: Page): Promise<number> {
  return page.evaluate(async (budget: number) => {
    const started = performance.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), budget);
    try {
      await fetch('/api/health', { signal: controller.signal, cache: 'no-store' });
      clearTimeout(timer);
      return Math.round(performance.now() - started);
    } catch {
      clearTimeout(timer);
      // Starved: report the full budget so the assertion fails on the number.
      return budget;
    }
  }, PROBE_CEILING_MS + 2000);
}

/** The durable streams a page currently holds open. */
function openStreams(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __dorkStreams: string[] }).__dorkStreams);
}

test.describe('several cockpit windows', () => {
  // Generous, because the RED case is slow by nature: on the unfixed code the
  // fourth window's own HTML never arrives, so the failure is a `goto` that
  // burns its whole timeout. The suite default (30s) turned that into a bare
  // test-timeout with nothing naming the window.
  test.setTimeout(90_000);

  test('stay responsive with four windows open on different sessions', async ({
    browser,
    request,
    baseURL,
  }) => {
    // A real agent directory, so every window opens a real chat and therefore
    // attaches a session stream (trap 4). Seeded through the test-mode server's
    // own seam, the same one chat-mock.spec.ts uses.
    const apiUrl = baseURL!.replace(/:\d+$/, `:${process.env.DORKOS_MOCK_PORT || '4243'}`);
    const seeded = await request.post(`${apiUrl}/api/test/seed-agent`);
    expect(seeded.ok(), 'could not seed an agent for the windows to open').toBe(true);
    const { agentDir } = (await seeded.json()) as { agentDir: string };

    // ONE context — real windows of one browser share a profile, and therefore
    // share the socket budget this is about (trap 1).
    const context = await browser.newContext();
    const pages: Page[] = [];

    try {
      for (let index = 0; index < WINDOW_COUNT; index += 1) {
        const page = await context.newPage();
        await page.addInitScript(COUNT_STREAMS);
        // A DIFFERENT session id per window (trap 3), each with the seeded dir.
        // The bounded `goto` and the step name are how the RED case reports
        // itself: on the unfixed code the fourth window's document never
        // arrives, and without these that is an anonymous test timeout rather
        // than "open window 4" failing.
        await test.step(`open window ${index + 1}`, async () => {
          await page.goto(`/session?session=${randomUUID()}&dir=${encodeURIComponent(agentDir)}`, {
            waitUntil: 'domcontentloaded',
            timeout: 20_000,
          });
        });
        pages.push(page);
        await page.waitForTimeout(SETTLE_MS);
      }

      // The cheap invariant first: streams are genuinely connected, and no
      // window opens more than its share (the global stream, its session's, and
      // at most a room's).
      const perPage = await Promise.all(pages.map(openStreams));
      const total = perPage.reduce((sum, list) => sum + list.length, 0);
      // The exact number is knowable, so assert it rather than a floor that
      // trap 4 would sail through: every window holds the global stream AND its
      // session's, so four windows hold eight. A guard of `>= WINDOW_COUNT`
      // would pass on windows that opened only the global stream — which is
      // precisely the vacuous shape this exists to catch.
      expect(
        total,
        `expected ${WINDOW_COUNT * 2} durable streams (the global one plus a session ` +
          `stream per window); saw ${JSON.stringify(perPage)}. Fewer means the windows ` +
          'never attached a session stream, and the probe below would prove nothing.'
      ).toBeGreaterThanOrEqual(WINDOW_COUNT * 2);
      expect(
        total,
        `each window should hold a small, bounded number of streams; saw ${JSON.stringify(perPage)}`
      ).toBeLessThanOrEqual(WINDOW_COUNT * 3);

      // The bug itself: a plain request from the FIRST window, made from inside
      // the browser so it draws on the same pool the streams do.
      const elapsed = await probeFromPage(pages[0]!);
      expect(
        elapsed,
        `GET /api/health from window 1 took ${elapsed}ms with ${WINDOW_COUNT} windows open ` +
          `holding ${total} durable streams — they are consuming the per-origin socket ` +
          'budget again (DOR-927)'
      ).toBeLessThan(PROBE_CEILING_MS);

      // And every other window is equally alive, not just the one that happened
      // to open first.
      for (const [index, page] of pages.entries()) {
        const each = await probeFromPage(page);
        expect(each, `window ${index + 1} was starved (${each}ms)`).toBeLessThan(PROBE_CEILING_MS);
      }
    } finally {
      await context.close();
    }
  });
});
