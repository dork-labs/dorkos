import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { createTestDb } from '@dorkos/test-utils/db';
import { messages, type Db } from '@dorkos/db';
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
 */

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

/** How many containers a sweep has to be wide before the point is made. */
const CONTAINERS = 500;

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
  it('lets a timer fire while it is still working', async () => {
    // A real interval, not a fake one: the claim is about the event loop itself,
    // and a fake timer would report a turn the loop never actually took.
    let ticks = 0;
    let containersRead = 0;
    let firstTickAtContainer: number | null = null;
    const source = wideSource(() => {
      containersRead += 1;
      if (ticks > 0 && firstTickAtContainer === null) firstTickAtContainer = containersRead;
    });

    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 1);
    let swept;
    try {
      swept = await new SearchIndexer(db, [source]).sweep();
    } finally {
      clearInterval(heartbeat);
    }

    expect(swept.indexed).toBe(CONTAINERS);
    // `null` is the whole of the old behaviour: the timer was due within a
    // millisecond and could not run until every one of the 500 containers had
    // been read and written.
    expect(firstTickAtContainer).not.toBeNull();
    expect(firstTickAtContainer).toBeLessThan(CONTAINERS);
  });

  it('returns from start() long before the first sweep has indexed everything', async () => {
    // The startup sweep is documented as un-awaited, and that was true of the
    // PROMISE while being false of the work: a synchronous pass ran to completion
    // inside `start()` itself, so boot waited for it whether it awaited or not.
    const indexer = new SearchIndexer(db, [wideSource(() => {})]);

    indexer.start();
    const indexedWhenStartReturned = db.select().from(messages).all().length;
    indexer.stop();

    expect(indexedWhenStartReturned).toBe(0);
    // And it still finishes — a sweep that yields is not a sweep that stalls.
    await vi.waitFor(() => {
      expect(db.select().from(messages).all()).toHaveLength(CONTAINERS);
    });
  });
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

  it('lets the loop run between files that have not changed', async () => {
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

    const second = await sweepFileSource(db, observed, '2026-08-26T10:05:00.000Z');

    expect(second.indexed).toBe(0);
    expect(second.containers).toBe(files);
    expect(loopRanDuringSweep).toBe(true);
  });
});
