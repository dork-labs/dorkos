/**
 * The one WatcherManager test that touches the real filesystem, a real chokidar
 * watcher and a real MaildirStore. The hermetic contracts live in
 * `./watcher-manager.test.ts`.
 *
 * @module __tests__/watcher-manager.smoke
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { WatcherManager } from '../watcher-manager.js';
import type { SubscriptionRegistry } from '../subscription-registry.js';
import { MaildirStore } from '../maildir-store.js';
import type { SqliteIndex } from '../sqlite-index.js';
import type { CircuitBreakerManager } from '../circuit-breaker.js';
import { loadCeilingMs, loadScaledMs } from '@dorkos/shared/test-budget';
import { interceptChokidar, deferred, type ChokidarInterceptor } from './fake-watcher.js';
import {
  createSpyLogger,
  isExhaustion,
  watcherErrorCodesSince,
  createMockSubscriptionRegistry,
  createMockSqliteIndex,
  createMockCircuitBreaker,
  armDeliveryBarrier,
  withDeadline,
} from './watcher-manager.fixtures.js';

describe('WatcherManager', () => {
  let subscriptionRegistry: SubscriptionRegistry;
  let sqliteIndex: SqliteIndex;
  let circuitBreaker: CircuitBreakerManager;
  let chokidarSpy: ChokidarInterceptor;

  beforeEach(() => {
    chokidarSpy = interceptChokidar();
    subscriptionRegistry = createMockSubscriptionRegistry();
    sqliteIndex = createMockSqliteIndex();
    circuitBreaker = createMockCircuitBreaker();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // The one test in this file that touches the real filesystem, a real
  // chokidar watcher and a real MaildirStore.
  //
  // Everything above drives the dispatch contracts against doubles. This proves
  // the wiring underneath them, in two halves:
  //
  //  1. The sweep's own path — a real `ready`, the real `listNew` behind it,
  //     and the real `claim`/`complete` that move a message out of the mailbox.
  //     Its file is written BEFORE the watcher exists, so it arrives by
  //     directory listing, which is why this half needs no retry loop: a
  //     listing cannot be dropped. (It used to need one. Delivery depended on
  //     catching a real `add`, and chokidar reports `ready` a beat before libuv
  //     starts delivering, so an early write was dropped outright rather than
  //     delivered late — no amount of waiting recovered it, only a fresh
  //     filename. Measured on macOS; see READY_DELIVERY_GRACE_MS in
  //     access-control.ts, and DOR-577.)
  //
  //  2. The `add` path, which half 1 no longer touches: that a real chokidar
  //     event fires for a file written into a live `new/`, and that the path it
  //     hands back has the message id as its basename — the assumption every
  //     hermetic test encodes, and one a chokidar major could change silently.
  //     Sever `watcher.on('add')` and only fake-watcher tests would notice.
  //
  // Half 2 is the only wall-clock bound left in this file, and it is bounded
  // four ways over: it writes well past the ready window rather than into it,
  // waits on a barrier with a short deadline, re-arms that write inside one open
  // watch, and then re-opens the WATCH itself a few times whenever a window came
  // back empty. Only once every window has come back empty is a verdict reached,
  // and what it says depends on what those windows reported: descriptor
  // exhaustion every time is a skip, anything else is a red.
  // -------------------------------------------------------------------------

  describe('real filesystem smoke', () => {
    /**
     * Ceiling on the sweep's delivery — generous, and paid only on failure.
     *
     * Scaled by load, and SAMPLED WHEN THE WAIT STARTS rather than at import:
     * twenty seconds is ample on a quiet machine and not ample beside three
     * other agents' suites, which is how this reddened branches that never
     * touched the relay (DOR-2012). A budget frozen at module load reads the
     * one-minute average from before the sweep that needed it began, which is
     * exactly the case the pre-push gate hits.
     */
    const smokeBudgetMs = (): number => loadScaledMs(20_000);
    /**
     * How long to let the platform's event stream warm up before the live write.
     *
     * Ten times the 25ms `READY_DELIVERY_GRACE_MS` that `access-control.ts`
     * measured and found holds at a load average around 130. Writing INTO that
     * window is where an event is dropped 13-40% of the time, so stepping over
     * it is what makes ONE attempt likely to land; the re-arm below is what
     * makes the case honest when it does not.
     */
    const READY_SETTLE_MS = 250;
    /**
     * Ceiling on ONE live `add`, and how many writes one open watch gets.
     *
     * Clamped to twice the base rather than the default four: this waits for one
     * filesystem event, not for work the machine has to do, and the whole case
     * has to reach its verdict inside a 120s timeout that `VITEST_RETRY` can
     * triple. At the default clamp a genuine red measured 98s — close enough to
     * the cap that the failure message could be lost to a bare timeout.
     */
    const LIVE_ATTEMPT_CLAMP = 2;
    const liveAttemptMs = (): number => loadScaledMs(2_000, LIVE_ATTEMPT_CLAMP);
    const LIVE_ATTEMPTS = 3;
    /**
     * How many times the WATCH ITSELF is re-opened, and the pause before each.
     *
     * Paid only by a window that delivered nothing AND reported descriptor
     * exhaustion. Closing the watch hands its descriptors back, and the pause is
     * what gives whatever else on this machine is holding them a chance to do
     * the same — so a burst that one window alone would have called "exhausted,
     * skip" is usually just delivered by the next one.
     */
    const LIVE_REARMS = 3;
    const LIVE_REARM_BACKOFF_MS = 2_000;
    /**
     * The whole case's ceiling, derived from the budgets above rather than fixed.
     *
     * The startup sweep, then every window: its backoff, its settle, and its
     * attempts. Half again on top for the setup, the assertions and the teardown.
     *
     * The absolute cap is 120s, against a worst MEASURED skip of 100.7s, and it
     * is deliberately tight: `packages/relay/vitest.config.ts` honours
     * `VITEST_RETRY`, which the lefthook pre-push hook sets to 2, so a genuine
     * red costs three times whatever this says — on the very gate DOR-2012
     * exists to keep survivable. The arm-time exit below is what keeps the
     * ordinary exhausted run far under it.
     */
    const SMOKE_TEST_TIMEOUT_MS = Math.min(
      120_000,
      Math.round(
        1.5 *
          (loadCeilingMs(20_000) +
            READY_SETTLE_MS +
            (LIVE_REARMS + 1) *
              (LIVE_REARM_BACKOFF_MS +
                READY_SETTLE_MS +
                LIVE_ATTEMPTS * loadCeilingMs(2_000, LIVE_ATTEMPT_CLAMP)))
      )
    );

    it(
      'reaches the handler both from the listing and from a real add event, keyed by basename',
      async (ctx) => {
        chokidarSpy.restore();
        const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'watcher-mgr-smoke-'));
        // A real store, not the double: `listNew` and `claim` are the two calls
        // the sweep leans on, and a mocked listing would prove only that the
        // mock returns what it was told to.
        const store = new MaildirStore({ rootDir: tmpDir });
        await store.ensureMaildir('hash-real');
        const claimSpy = vi.spyOn(store, 'claim');
        // A real logger, because the watcher's own error report is the only thing
        // that separates "the watch is broken" from "the kernel is out of watch
        // descriptors" when half 2 below delivers nothing.
        const smokeLogger = createSpyLogger();
        const smokeManager = new WatcherManager(
          store,
          subscriptionRegistry,
          sqliteIndex,
          circuitBreaker,
          smokeLogger
        );
        const newDir = path.join(tmpDir, 'hash-real', 'new');
        const smokeEndpoint = {
          subject: 'relay.agent.smoke',
          hash: 'hash-real',
          maildirPath: path.join(tmpDir, 'hash-real'),
          registeredAt: '2026-02-24T00:00:00.000Z',
        };

        const handler = vi.fn();
        vi.mocked(subscriptionRegistry.getSubscribers).mockReturnValue([handler]);
        const delivered = armDeliveryBarrier(sqliteIndex);

        try {
          // Written before the watcher exists: the message this endpoint missed
          // while it was down, which is the wider half of what the sweep covers.
          await fs.writeFile(
            path.join(newDir, 'msg-real.json'),
            JSON.stringify({ subject: 'test' })
          );

          await smokeManager.startWatcher(smokeEndpoint);

          await withDeadline(
            delivered.promise,
            smokeBudgetMs(),
            `a real watcher over ${newDir} delivered nothing`
          );

          expect(claimSpy).toHaveBeenCalledWith('hash-real', 'msg-real');
          expect(handler).toHaveBeenCalledWith({ subject: 'test' });
          // Exactly once against a real listing, a real claim and a real watcher:
          // `ignoreInitial` keeps chokidar off the file, and the atomic rename
          // behind `claim` settles it if anything else reaches for it anyway.
          expect(handler).toHaveBeenCalledTimes(1);
          expect(sqliteIndex.updateStatus).toHaveBeenCalledWith(
            'msg-real',
            'hash-real',
            'delivered'
          );
          // Delivered means gone from the mailbox — claimed out of new/ and
          // completed out of cur/.
          expect(await store.listNew('hash-real')).toEqual([]);
          expect(await store.listCurrent('hash-real')).toEqual([]);

          // --- Half 2: the live `add` path, which the sweep did not exercise.
          //
          // Re-armed rather than waited on once (DOR-1850's lesson): a real
          // chokidar event is not a promise the platform keeps. A file written in
          // the moments after a watch opens is dropped 13-40% of the time, and
          // sustained load exhausts the kernel's watch descriptors outright, after
          // which `fs.watch` reports nothing at all.
          //
          // So this runs in WINDOWS. Inside one window the watch stays open and
          // each attempt writes its OWN message id — a leftover from an earlier
          // attempt would otherwise satisfy a later one's barrier — waits a
          // bounded moment, and tidies up before the next. A window that delivers
          // nothing then has to say WHY before anything is decided, and only one
          // answer buys another window: this window's own watch reported EMFILE or
          // ENOSPC. Then the watch is closed (which hands its descriptors back),
          // the machine is given a pause, and a fresh watch opens on the same
          // mailbox.
          //
          // That second question is the one this used to get wrong. Asking only
          // "was EMFILE reported at any point" let a genuine `add` regression that
          // happened to coincide with an fd burst skip instead of redding, and it
          // self-skipped twice in 31 runs of healthy code at a load average of 26.
          // A re-arm answers it: if the descriptors were the problem, the next
          // window delivers; if the watch is broken, the next window fails again
          // and reports nothing, which is a red.
          await new Promise<void>((resolve) => setTimeout(resolve, READY_SETTLE_MS));

          let liveId: string | undefined;
          /** One entry per window that came back empty, for the verdict below. */
          const emptyWindows: { line: string; exhausted: boolean }[] = [];
          /** What the LAST window's own watch reported. The verdict rests on this. */
          let windowCodes: string[] = [];
          /**
           * Where this window's watch starts answering for what the logger says.
           *
           * ZERO for the first window, and that is not an off-by-one: the watch it
           * uses is the one half 1 armed, so everything reported since the test
           * began belongs to it. ARMING is exactly when a machine out of watch
           * descriptors says so, and a baseline taken after `startWatcher` puts a
           * window's own EMFILE outside its own window — the window then reads as
           * "delivered nothing, reported nothing", which is the red reserved for a
           * broken watch. Measured twice: with the baseline after the re-arm's
           * `startWatcher`, a seeded burst that clears reddened instead of
           * re-arming; with it after half 1's, a genuinely exhausted machine that
           * the previous shape skipped on 3 runs of 3 reddened on this one.
           */
          let windowBaseline = 0;

          for (let window = 0; window <= LIVE_REARMS && !liveId; window++) {
            if (window > 0) {
              windowBaseline = vi.mocked(smokeLogger.warn).mock.calls.length;
              await smokeManager.closeAll();
              await new Promise<void>((resolve) => setTimeout(resolve, LIVE_REARM_BACKOFF_MS));
              // Nothing an earlier window left behind, so the new watch's own
              // `sweepPending` cannot deliver a message and be mistaken for the
              // `add` path this half exists to exercise.
              for (const stale of await fs.readdir(newDir)) {
                await fs.rm(path.join(newDir, stale), { force: true });
              }
              await smokeManager.startWatcher(smokeEndpoint);
              await new Promise<void>((resolve) => setTimeout(resolve, READY_SETTLE_MS));
            }

            // A watch that could not arm at all says so at ARMING, before any
            // write. Asking here costs nothing and saves this window its three
            // attempts: on a machine whose FSEvents is exhausted, that is the
            // difference between ~8s and the 69.7s and 100.7s measured reaching
            // the same skip. The window is still recorded, so the verdict below
            // is unchanged.
            if (watcherErrorCodesSince(smokeLogger, windowBaseline).some(isExhaustion)) {
              emptyWindows.push({
                line: `window ${window}: the watch never armed (${watcherErrorCodesSince(
                  smokeLogger,
                  windowBaseline
                ).join(', ')})`,
                exhausted: true,
              });
              // Two in a row means the machine, not this window. Re-arming a
              // third and fourth time only spends backoff to reach the same
              // skip, and under `VITEST_RETRY` that spend is tripled.
              if (emptyWindows.length >= 2 && emptyWindows.every((entry) => entry.exhausted)) break;
              continue;
            }

            for (let attempt = 0; attempt < LIVE_ATTEMPTS && !liveId; attempt++) {
              const id = `msg-live-${window}-${attempt}`;
              const liveDelivered = deferred();
              vi.mocked(sqliteIndex.updateStatus).mockImplementation((messageId) => {
                if (messageId === id) liveDelivered.resolve();
                return true;
              });
              const filePath = path.join(newDir, `${id}.json`);
              await fs.writeFile(filePath, JSON.stringify({ subject: 'live' }));
              try {
                await withDeadline(
                  liveDelivered.promise,
                  liveAttemptMs(),
                  `a real chokidar 'add' on ${newDir} delivered nothing`
                );
                liveId = id;
              } catch {
                // Undelivered mail this attempt wrote, out of the way of the next
                // attempt's `listNew` assertion. A late `add` for it then loses the
                // claim to ENOENT, which is exactly what the real store does.
                await fs.rm(filePath, { force: true });
              }
            }

            windowCodes = watcherErrorCodesSince(smokeLogger, windowBaseline);
            if (!liveId) {
              // A window that came back empty gets another one WHATEVER it
              // reported. Descriptor exhaustion is one reason; the other is that
              // macOS drops the event outright and says nothing — 7 of 20 single
              // writes under a real watcher at a load average of 78, measured
              // 2026-09-12 — and this used to break out and red on exactly that.
              // The verdict below is what separates the two, once every window
              // has had its turn.
              emptyWindows.push({
                line: `window ${window}: ${LIVE_ATTEMPTS} writes, none delivered (${
                  windowCodes.join(', ') || 'no error reported'
                })`,
                exhausted: windowCodes.some(isExhaustion),
              });
            }
          }

          if (liveId) {
            expect(claimSpy).toHaveBeenCalledWith('hash-real', liveId);
            expect(handler).toHaveBeenCalledWith({ subject: 'live' });
            expect(await store.listNew('hash-real')).toEqual([]);
            return;
          }

          // Every window came back empty, and what that means is decided by
          // what the windows themselves reported. Exhausted every time is the
          // condition `sweepPending` exists for, not a fault in this code, and
          // it skips loudly so a case that has stopped asserting is visible in
          // the report. Anything else is a red.
          const report = emptyWindows.map((entry) => entry.line).join('; ');
          expect(
            emptyWindows.every((entry) => entry.exhausted),
            `${emptyWindows.length} fresh watches delivered nothing — ${report}`
          ).toBe(true);
          ctx.skip(
            `watch descriptors exhausted on every one of ${emptyWindows.length} windows (${report}); the startup sweep is what covers this, and half 1 above asserts it`
          );
        } finally {
          await smokeManager.closeAll();
          await fs.rm(tmpDir, { recursive: true, force: true });
        }
      },
      SMOKE_TEST_TIMEOUT_MS
    );
  });
});
