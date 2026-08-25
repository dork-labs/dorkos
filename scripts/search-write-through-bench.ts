/**
 * What the message-index write-through costs a room post — on a caught-up room,
 * and on one the index is behind on (message-search spec Amendment 6, DOR-684).
 *
 * Run it with:
 *
 * ```bash
 * DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-write-through-bench.ts
 * ```
 *
 * It exists because the first number quoted for this feature — 0.237 ms per post
 * — is true only of the case it was measured on, and the case it was NOT measured
 * on is the one that hurts: a room the index has never seen projects its whole
 * backlog synchronously inside `publishEntry`. This prints both, so the figure in
 * `write-through.ts` can be re-derived rather than inherited, and so the bound
 * that separates them (`WRITE_THROUGH_MAX_BACKLOG`) is chosen from a curve.
 *
 * Synthetic rather than a real corpus: rooms are DorkOS's own rows, so a room of
 * any size can be built in a temp directory in a second, and no part of this
 * touches `~/.dork`. It is env-gated anyway, matching its two sibling benches —
 * these are deliberate measurements, not something a test run should wander into.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createDb, runMigrations, roomEntries, messages } from '../packages/db/src/index.js';
import { indexRowContainer } from '../apps/server/src/services/search/row-frontier.js';
import { roomsSource } from '../apps/server/src/services/search/registry.js';

// Same carve-out as its siblings: a root-workspace script with one gate variable
// read before anything else loads.
// eslint-disable-next-line no-restricted-syntax
if (process.env.DORKOS_SEARCH_BENCH !== '1') {
  console.error(
    'search-write-through-bench builds a synthetic room log and measures indexing.\n' +
      'Run it deliberately:\n\n' +
      '  DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-write-through-bench.ts\n'
  );
  process.exit(2);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-wt-bench-'));

/** Append `count` entries to one room, without indexing any of them. */
function seed(db: ReturnType<typeof createDb>, roomId: string, from: number, count: number): void {
  db.transaction((tx) => {
    for (let i = 0; i < count; i += 1) {
      const seq = from + i;
      tx.insert(roomEntries)
        .values({
          id: `${roomId}-${seq}`,
          roomId,
          seq,
          kind: 'post',
          authorId: 'author-human',
          body: JSON.stringify({ text: `entry ${seq} about the migration we keep discussing` }),
          createdAt: '2026-08-01T00:00:00.000Z',
          cascadeRoot: `${roomId}-${seq}`,
          cascadeDepth: 0,
        })
        .run();
    }
  });
}

/** Index one room at its current end, and report how long that took. */
function indexNow(db: ReturnType<typeof createDb>, roomId: string, maxOrdinal: number): number {
  const started = process.hrtime.bigint();
  indexRowContainer(
    db,
    roomsSource,
    { originKey: roomId, containerPath: null, maxOrdinal },
    new Date().toISOString()
  );
  return Number(process.hrtime.bigint() - started) / 1e6;
}

try {
  const db = createDb(path.join(workdir, 'bench.db'));
  runMigrations(db);

  // The warm path, measured as a DELTA rather than as a total: the same run of
  // appends with the write-through and without it. The absolute cost of appending
  // an entry is not what this number is about — what it costs to ALSO index it is.
  const WARM_POSTS = 300;
  const appendOnly = (roomId: string, index: boolean): number => {
    seed(db, roomId, 1, 1);
    if (index) indexNow(db, roomId, 1);
    const started = process.hrtime.bigint();
    for (let seq = 2; seq <= WARM_POSTS + 1; seq += 1) {
      seed(db, roomId, seq, 1);
      if (index) indexNow(db, roomId, seq);
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  appendOnly('warmup', false); // discarded: first writes pay for page allocation
  const withoutMs = appendOnly('warm-plain', false);
  const withMs = appendOnly('warm-indexed', true);
  const warmPerPost = (withMs - withoutMs) / WARM_POSTS;

  // The cold path: the first post into a room with a backlog, at several depths,
  // so the bound is read off a curve rather than off one point.
  const depths = [200, 1_000, 5_000, 20_000];
  const cold: Array<{ depth: number; ms: number }> = [];
  for (const depth of depths) {
    const roomId = `cold-${depth}`;
    seed(db, roomId, 1, depth);
    cold.push({ depth, ms: indexNow(db, roomId, depth) });
  }

  console.log(
    `warm_posts=${WARM_POSTS} without_ms=${withoutMs.toFixed(1)} with_ms=${withMs.toFixed(1)} ` +
      `warm_per_post_delta_ms=${warmPerPost.toFixed(3)}`
  );
  for (const point of cold) {
    console.log(
      `cold_backlog=${point.depth} inline_ms=${point.ms.toFixed(1)} ` +
        `per_entry_ms=${(point.ms / point.depth).toFixed(4)}`
    );
  }
  console.log(`indexed_rows=${db.select({ id: messages.id }).from(messages).all().length}`);
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
