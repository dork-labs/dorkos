/**
 * Rebuild the message-search index from this machine's real Claude Code
 * transcripts, and print what it cost.
 *
 * Run it with:
 *
 * ```bash
 * DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-corpus-bench.ts
 * ```
 *
 * **It is env-gated on purpose.** It reads every transcript the operator has,
 * which is slow, machine-specific and nobody's business in CI — so it refuses to
 * run without `DORKOS_SEARCH_BENCH=1` and says how to ask. It writes to a
 * throwaway database in the system temp directory and removes it afterwards;
 * nothing it does touches `~/.dork` or any transcript, which are read-only to
 * this whole subsystem by design.
 *
 * **It is run with `tsx`, not `node --experimental-strip-types`.** The server's
 * sources are `NodeNext` and import each other with `.js` specifiers that resolve
 * to `.ts` files, which type stripping alone cannot follow. `tsx` is what the
 * repo already uses for every script that reaches into `apps/server`.
 *
 * The thresholds below are floors that a genuine regression trips and normal
 * corpus growth does not. They are deliberately not tight: absolute timings move
 * by ~2× with machine load on a workstation running several agents, so a tight
 * budget here would be flaky rather than informative (spec Amendment 1).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// By relative path rather than by package name: this file sits in the root
// workspace, which does not depend on `@dorkos/db`. The package resolves its own
// entry to `src/index.ts`, so both spellings load the same module.
import { createDb, runMigrations, messages, searchSources, eq } from '../packages/db/src/index.js';
import { sweepFileSource } from '../apps/server/src/services/search/jsonl-frontier.js';
import { claudeCodeSource } from '../apps/server/src/services/search/registry.js';
import { resolveActiveClaudeRoot } from '../apps/server/src/services/runtimes/claude-code/claude-config-dir.js';

/**
 * The fewest messages a healthy index of this corpus holds.
 *
 * **Measured 2026-08-24 on the operator's machine: 9,110 messages from 174
 * files in `~/.claude`.** DOR-681's task text expected 17,989 from 236 files,
 * measured 2026-07-28. **Two things account for the gap, and only one of them
 * is the corpus.**
 *
 * 1. **Rotation.** Claude Code deletes transcripts older than
 *    `cleanupPeriodDays` (30 by default), so a single root holds a moving
 *    30-day window rather than a growing archive: 207 main sessions exist there
 *    today, of which 33 are eval sandboxes, against 236 four weeks ago.
 * 2. **This commit's own authorship gate.** Counting every `user`/`assistant`
 *    record with text across the same 174 files gives 11,196; the projection
 *    keeps 9,110. The 2,087 difference is deliberate — 1,489
 *    `<task-notification>` blocks, 503 CLI-internal records, 56 local-command
 *    outputs, 23 compaction summaries, 4 bash outputs, 12 agent relay
 *    hand-offs — and it is measured in `projections/claude-code.ts`. The task's
 *    17,989 was a looser count than this index produces by design, so part of
 *    the gap would exist even on the older corpus.
 *
 * **Both causes are why this floor is a floor and not the measurement.** It sits
 * well below today's count so ordinary rotation never reddens it, and well above
 * zero because an empty index is the failure it exists to catch — a broken
 * projection answers every query in microseconds.
 *
 * DOR-682 raises it: reading every root instead of the active one roughly
 * doubles the corpus on this machine.
 */
const MIN_MESSAGES = 5_000;

/**
 * The longest a full rebuild may take.
 *
 * Measured 7.3 s for 174 files on a workstation running several agents. The
 * spec measured 2.69 s for 241 files on an idle one; absolute timings move ~2×
 * with load, so this ceiling is deliberately loose — it catches a rebuild that
 * has become quadratic, not one that had to share a CPU.
 */
const MAX_REBUILD_MS = 30_000;

// The rule points at each app's Zod-validated `env.ts`, and this file is not in
// an app: it is a root-workspace script with one gate variable that must be read
// before anything else loads. Importing a server env module to read it would
// boot the server's whole configuration to answer "did you mean this?".
// eslint-disable-next-line no-restricted-syntax
if (process.env.DORKOS_SEARCH_BENCH !== '1') {
  console.error(
    'search-corpus-bench reads every Claude Code transcript on this machine.\n' +
      'Run it deliberately:\n\n' +
      '  DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-corpus-bench.ts\n'
  );
  process.exit(2);
}

const roots = [resolveActiveClaudeRoot()];
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-search-bench-'));
const dbPath = path.join(workdir, 'bench.db');

try {
  const db = createDb(dbPath);
  runMigrations(db);

  const started = process.hrtime.bigint();
  const sweep = await sweepFileSource(db, claudeCodeSource, new Date().toISOString());
  const rebuildMs = Number(process.hrtime.bigint() - started) / 1e6;

  const indexed = db.select({ ordinal: messages.ordinal }).from(messages).all().length;
  const containers = db
    .select({ originKey: searchSources.originKey })
    .from(searchSources)
    .where(eq(searchSources.sourceId, 'claude-code'))
    .all().length;
  // Every page the index actually occupies, WAL included — the file alone
  // understates it while the database is still open.
  const dbBytes = ['', '-wal', '-shm'].reduce(
    (total, suffix) =>
      total + (fs.statSync(`${dbPath}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
    0
  );

  console.log(
    [
      `roots=${roots.length}`,
      `rootPaths=${roots.join(',')}`,
      `files=${sweep.containers}`,
      `containers=${containers}`,
      `messages=${indexed}`,
      `skippedLines=${sweep.skipped}`,
      `failures=${sweep.failures.length}`,
      `rebuildMs=${rebuildMs.toFixed(0)}`,
      `dbBytes=${dbBytes}`,
    ].join(' ')
  );

  for (const failure of sweep.failures.slice(0, 10)) {
    console.error(`  failed: ${failure.originKey} — ${failure.message}`);
  }

  // The hit count is asserted BEFORE the timing. An empty or broken index is
  // fast, so a duration-only assertion passes most loudly exactly when the
  // feature is most broken.
  const problems: string[] = [];
  if (indexed < MIN_MESSAGES) problems.push(`messages=${indexed} is below ${MIN_MESSAGES}`);
  if (rebuildMs > MAX_REBUILD_MS)
    problems.push(`rebuildMs=${rebuildMs.toFixed(0)} is above ${MAX_REBUILD_MS}`);
  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
