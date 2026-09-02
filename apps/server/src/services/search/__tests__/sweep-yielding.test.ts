import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { setImmediate as nextEventLoopTurn } from 'node:timers/promises';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, count, type Db } from '@dorkos/db';
import { SearchIndexer } from '../indexer.js';
import { sweepFileSource } from '../jsonl-frontier.js';
import { createClaudeCodeSource } from '../registry.js';
import type { FileSource, RowSource } from '../types.js';

/**
 * The sweep has to share the process it runs in (DOR-702).
 *
 * `better-sqlite3` is synchronous, so a row source's whole pass — discovery,
 * every container's read, every write — used to run in ONE unbroken block: 4,000
 * rooms measured at 36.6ms with zero turns of the event loop, and a first index
 * over a real transcript corpus is far larger than that. Nothing else in the
 * process moves while that runs, the startup sweep included, so the server does
 * not answer a request until it finishes.
 *
 * These tests assert the loop gets turns DURING a sweep, which is the only thing
 * that distinguishes "shares the process" from "is merely declared async".
 *
 * **Every check below counts turns of the event loop, never milliseconds**
 * (DOR-1689). Both halves of the claim are ordering, not speed: the loop got a
 * turn between containers, and it got roughly one per container. Measuring that
 * with a 1ms `setInterval` and a one-second `vi.waitFor` instead made the file
 * report how busy the MACHINE was — it redded five pre-push gates across four
 * unrelated branches and, reproduced here, 24 of 24 runs under 24 concurrent
 * vitest processes, each time with the sweep working correctly and simply not
 * finished (485 of 500 rows written when the stopwatch expired). A turn is the
 * unit the sweep actually spends, and load cannot buy fewer of them.
 */

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

/** How many containers a sweep has to be wide before the point is made. */
const CONTAINERS = 500;

/**
 * How long the runner waits for one of these tests.
 *
 * Not a bound on anything the sweep promises — nothing below is asserted in
 * time, so raising this weakens no check. It exists because the WORK here is
 * genuinely large (500 synchronous SQLite writes, 200 files created and read),
 * and a machine already running other suites stretches it: measured at 320ms
 * idle and 3.5s under 24 concurrent vitest processes, with vitest's 5s default
 * sitting inside that range.
 */
const SLOW_UNDER_LOAD_MS = 60_000;

/** A running count of event-loop turns. */
interface EventLoopTurnCounter {
  /** Turns the loop has taken since counting started. */
  readonly turns: number;

  /** Stop counting, so the pump does not outlive the test. */
  stop: () => void;
}

/**
 * Count turns of the event loop until the returned handle is stopped.
 *
 * A `setImmediate` re-queued from inside the check phase runs on the NEXT turn
 * of the loop and never the current one, so a self-rescheduling chain of them
 * increments exactly once per turn. That is the unit a yielding sweep spends —
 * one turn per container, because that is what `yieldToEventLoop` costs — and
 * unlike a millisecond, a loaded machine cannot make the sweep spend fewer.
 */
function countEventLoopTurns(): EventLoopTurnCounter {
  let turns = 0;
  let running = true;
  const pump = (): void => {
    if (!running) return;
    turns += 1;
    setImmediate(pump);
  };
  setImmediate(pump);
  return {
    get turns() {
      return turns;
    },
    stop: () => {
      running = false;
    },
  };
}

/**
 * Hand the event loop turns until `settled()` holds, giving up after `maxTurns`.
 *
 * The turn-counted answer to `vi.waitFor`: a sweep that is progressing needs a
 * bounded number of TURNS to finish however slow each one is, while a sweep that
 * has stalled never finishes however many it is given — so the bound still fails
 * a real stall, and no amount of load can trip it.
 */
async function settleWithinTurns(settled: () => boolean, maxTurns: number): Promise<void> {
  for (let spent = 0; spent < maxTurns && !settled(); spent += 1) {
    await nextEventLoopTurn();
  }
}

/** A row source of {@link CONTAINERS} containers, each holding one message. */
function wideSource(onRead: (originKey: string) => void): RowSource {
  return {
    id: 'wide',
    mechanism: 'rows',
    listContainers: () =>
      Array.from({ length: CONTAINERS }, (_unused, i) => ({
        originKey: `container-${String(i)}`,
        containerPath: null,
        maxOrdinal: 1,
      })),
    readSince: (_db, originKey) => {
      onRead(originKey);
      return {
        skipped: 0,
        messages: [
          {
            originKey,
            ordinal: 1,
            messageId: null,
            role: 'user' as const,
            createdAt: null,
            body: `something said in ${originKey}`,
          },
        ],
      };
    },
  };
}

describe('a wide row sweep', () => {
  it(
    'lets the event loop turn while it is still working',
    async () => {
      let containersRead = 0;
      let firstTurnAtContainer: number | null = null;
      const loop = countEventLoopTurns();
      const source = wideSource(() => {
        containersRead += 1;
        if (loop.turns > 0 && firstTurnAtContainer === null) firstTurnAtContainer = containersRead;
      });

      let swept;
      try {
        swept = await new SearchIndexer(db, [source]).sweep();
      } finally {
        loop.stop();
      }

      expect(swept.indexed).toBe(CONTAINERS);
      // `null` is the whole of the old behaviour: the loop could not take a turn
      // until every one of the 500 containers had been read and written.
      expect(firstTurnAtContainer).not.toBeNull();
      expect(firstTurnAtContainer).toBeLessThan(CONTAINERS);
      // And it is a turn PER CONTAINER, not one turn somewhere in the middle —
      // the difference between a sweep that shares the process and one that
      // pauses once. Floored at half rather than pinned at `CONTAINERS` so the
      // exact turn the sweep's own promise resolves on cannot decide the result;
      // a sweep that stopped yielding spends none of these, and one that yielded
      // every tenth container would spend 50.
      expect(loop.turns).toBeGreaterThanOrEqual(CONTAINERS / 2);
    },
    SLOW_UNDER_LOAD_MS
  );

  it(
    'returns from start() long before the first sweep has indexed everything',
    async () => {
      // The startup sweep is documented as un-awaited, and that was true of the
      // PROMISE while being false of the work: a synchronous pass ran to completion
      // inside `start()` itself, so boot waited for it whether it awaited or not.
      const indexer = new SearchIndexer(db, [wideSource(() => {})]);

      indexer.start();
      const indexedWhenStartReturned = db.select().from(messages).all().length;
      indexer.stop();

      // Never part of the DOR-1689 flake, and deliberately left alone: this reads
      // the table in the same synchronous block that called `start()`, so it is
      // already an ordering assertion and no amount of load can move it.
      expect(indexedWhenStartReturned).toBe(0);

      // And it still finishes — a sweep that yields is not a sweep that stalls.
      // Waited out in turns rather than in milliseconds: this is where the flake
      // lived, and the sweep spends one turn per container, so four times that is
      // slack for discovery and the closing writes.
      const indexed = (): number => db.select({ rows: count() }).from(messages).all()[0]?.rows ?? 0;
      await settleWithinTurns(() => indexed() === CONTAINERS, CONTAINERS * 4);
      expect(db.select().from(messages).all()).toHaveLength(CONTAINERS);
    },
    SLOW_UNDER_LOAD_MS
  );
});

describe('a wide file sweep', () => {
  let root: string;
  let projects: string;
  let source: FileSource;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-search-yield-'));
    projects = path.join(root, 'projects');
    await fs.mkdir(projects, { recursive: true });
    source = createClaudeCodeSource(() => [projects]);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it(
    'lets the loop run between files that have not changed',
    async () => {
      // The file loop yields on real I/O whenever a file has something new, so the
      // starved case is the ordinary one: a corpus where nothing changed since the
      // last sweep costs no read at all, and the loop over it is pure synchronous
      // work — 19,000 iterations of it on the operator's own machine.
      const files = 200;
      const slug = path.join(projects, 'slug-a');
      await fs.mkdir(slug, { recursive: true });
      await Promise.all(
        Array.from({ length: files }, (_unused, i) =>
          fs.writeFile(
            path.join(slug, `session-${String(i)}.jsonl`),
            `${JSON.stringify({
              type: 'user',
              cwd: '/repo/project',
              timestamp: '2026-08-26T10:00:00.000Z',
              message: { role: 'user', content: `said in session ${String(i)}` },
            })}\n`
          )
        )
      );
      const first = await sweepFileSource(db, source, '2026-08-26T10:00:00.000Z');
      expect(first.indexed).toBe(files);

      // Observed with an immediate rather than a timer, because the answer is then
      // exact rather than a race: this one is queued before the loop's first yield,
      // so it runs first in the same check phase — at file 1 when the loop yields,
      // and not until the whole sweep is over when it does not.
      let loopRanDuringSweep = false;
      const observed: FileSource = {
        ...source,
        discover: async (known) => {
          const discovery = await source.discover(known);
          setImmediate(() => {
            loopRanDuringSweep = true;
          });
          return discovery;
        },
      };

      const loop = countEventLoopTurns();
      let second;
      try {
        second = await sweepFileSource(db, observed, '2026-08-26T10:05:00.000Z');
      } finally {
        loop.stop();
      }

      expect(second.indexed).toBe(0);
      expect(second.containers).toBe(files);
      expect(loopRanDuringSweep).toBe(true);
      // The same turn-per-container floor the row sweep asserts, for the same
      // reason: one turn somewhere is not the claim, a turn between files is.
      expect(loop.turns).toBeGreaterThanOrEqual(files / 2);
    },
    SLOW_UNDER_LOAD_MS
  );
});
