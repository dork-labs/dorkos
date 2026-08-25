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
 * throwaway database in the system temp directory and removes it afterwards, and
 * it writes nowhere else. `~/.dork` and every transcript are read-only to this
 * whole subsystem by design, and that includes the settings it reads to work out
 * which accounts to cover: the config file is loaded with `readFileSync`, never
 * through `initConfigManager`, which would run migrations and write a
 * `projectVersion` back into the operator's real settings.
 *
 * **It is run with `tsx`, not `node --experimental-strip-types`.** The server's
 * sources are `NodeNext` and import each other with `.js` specifiers that resolve
 * to `.ts` files, which type stripping alone cannot follow. `tsx` is what the
 * repo already uses for every script that reaches into `apps/server`.
 *
 * **Which accounts it covers is a real setting, so point it at the real one.**
 * The root set includes every account registered in `runtimes.claudeCode.accounts`,
 * and that lives in the DorkOS data directory. `resolveDorkHome()` answers
 * `.temp/.dork` in a dev tree, which usually holds no config at all, so the
 * production default is tried next and the path actually used is printed as
 * `config=`. To pin it explicitly:
 *
 * ```bash
 * DORK_HOME=$HOME/.dork DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-corpus-bench.ts
 * ```
 *
 * The thresholds below are floors that a genuine regression trips and normal
 * corpus growth does not. They are deliberately not tight: absolute timings move
 * by ~2× with machine load on a workstation running several agents, so a tight
 * budget here would be flaky rather than informative (spec Amendment 1).
 *
 * **What is asserted, and what is only printed.** Three things fail this script:
 * too few messages, a file under a resolved root that was not indexed, and a
 * rebuild past the ceiling. The `roots=`, `rootPaths=` and `perRoot=` fields are
 * **informational** — they let an operator see which accounts were covered, and
 * they are how the two-orderings check below is read by eye, but no assertion
 * reads them. That is on purpose: a `roots.length >= 2` gate would red on any
 * machine with one Claude account, while proving nothing a machine with two does
 * not already prove. The claim that matters — the shipped source reads every
 * root the resolver returned — is asserted by the per-root cross-check here and,
 * hermetically and on any machine, by `__tests__/claude-roots.test.ts`.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
// By relative path rather than by package name: this file sits in the root
// workspace, which does not depend on `@dorkos/db`. The package resolves its own
// entry to `src/index.ts`, so both spellings load the same module.
import { createDb, runMigrations, messages, searchSources, eq } from '../packages/db/src/index.js';
import { resolveDorkHome } from '../apps/server/src/lib/dork-home.js';
import { sweepFileSource } from '../apps/server/src/services/search/jsonl-frontier.js';
import { createClaudeCodeSource } from '../apps/server/src/services/search/registry.js';
import { discoverClaudeCodeTranscripts } from '../apps/server/src/services/search/claude-code-discovery.js';
import { resolveClaudeRootSet } from '../apps/server/src/services/runtimes/claude-code/claude-config-dir.js';
import type { KnownContainer } from '../apps/server/src/services/search/types.js';

/**
 * The fewest messages a healthy index of this corpus holds.
 *
 * **Measured 2026-08-25 on the operator's machine: 19,124 messages from 497
 * files across two roots** — 174 files under `~/.claude` and 323 under the
 * registered `~/.claude3`. DOR-681 measured 9,110 from 174 files with only
 * `~/.claude` in play, and the task text for both tickets expected 17,989 and
 * 18,000 from a 2026-07-28 single-root reading. **Three things move this number,
 * and only one of them is the corpus.**
 *
 * 1. **The root set — what DOR-682 changed.** Reading every registered account
 *    rather than the active one is what takes 9,110 to 19,124 here, and it is
 *    the same 19,124 whichever root the shell exports. It is also why this floor
 *    may not be inherited from a document: the answer depends on how many
 *    accounts THIS operator has registered.
 * 2. **Rotation.** Claude Code deletes transcripts older than
 *    `cleanupPeriodDays` (30 by default), so each root holds a moving 30-day
 *    window rather than a growing archive.
 * 3. **The authorship gate** in `projections/claude-code.ts`, which drops
 *    `<task-notification>` blocks, CLI-internal records, local-command outputs,
 *    compaction summaries and agent relay hand-offs. The task's 17,989 was a
 *    looser count than this index produces by design.
 *
 * **All three are why this is a floor and not the measurement.** It sits well
 * below today's count so ordinary rotation never reddens it, and it sits low
 * enough that a machine with a single account still passes — coverage is
 * asserted by the per-root cross-check below, which is machine-independent,
 * rather than by a message count, which is not. What the floor catches is an
 * empty or broken index, and it catches it before any timing is asserted,
 * because a broken projection answers every query in microseconds.
 */
const MIN_MESSAGES = 5_000;

/**
 * The longest a full rebuild may take.
 *
 * Measured **2.5 s to 24.8 s across five runs** for the same 497 files over the
 * same two roots — a **10× spread on one machine and one corpus**, decided
 * entirely by what else the workstation was doing: the slowest run shared the
 * CPU with a full `pnpm verify` and several other agents, the fastest had the
 * machine to itself. (The fast run also reproduces the spec's 2.69 s for a
 * comparable corpus on an idle machine, which is the same observation from the
 * other end.) That spread is the whole argument for a loose ceiling: it catches
 * a rebuild that has become quadratic, not one that had to share a CPU.
 */
const MAX_REBUILD_MS = 60_000;

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

/** The config reader shape {@link resolveClaudeRootSet} takes. */
type ConfigReader = Parameters<typeof resolveClaudeRootSet>[0];

/**
 * The operator's stored settings, read-only, or an empty reader when there are
 * none. Raw JSON is exactly what `configManager.get` hands back, so the account
 * healing inside `claude-config-dir.ts` applies identically.
 */
function readStoredConfig(): { path: string | null; reader: ConfigReader } {
  const candidates = [
    path.join(resolveDorkHome(), 'config.json'),
    path.join(os.homedir(), '.dork', 'config.json'),
  ];
  for (const candidate of candidates) {
    try {
      const stored = JSON.parse(fs.readFileSync(candidate, 'utf8')) as Record<string, unknown>;
      return {
        path: candidate,
        reader: { get: (key: string) => stored[key] } as unknown as ConfigReader,
      };
    } catch {
      continue;
    }
  }
  return { path: null, reader: { get: () => undefined } as unknown as ConfigReader };
}

const config = readStoredConfig();
const roots = resolveClaudeRootSet(config.reader);
const projectsRoots = roots.map((root) => path.join(root, 'projects'));
const source = createClaudeCodeSource(() => projectsRoots);
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-search-bench-'));
const dbPath = path.join(workdir, 'bench.db');

try {
  const db = createDb(dbPath);
  runMigrations(db);

  // The clock starts before discovery: walking several roots IS part of what a
  // rebuild costs, and timing only the read would hide the term that scales
  // with the number of accounts.
  const started = process.hrtime.bigint();
  const discovery = await source.discover(new Map());

  // **The coverage check, cross-checked against an independent enumeration.**
  // A root set of length two that still reads only the first root satisfies any
  // `roots.length` assertion, so the count has to come from somewhere else:
  // each root is enumerated again on its own and the union compared. The second
  // pass is cheap because it is handed what the first already learned — an
  // unchanged file is classified from that rather than from a fresh 64 KiB head
  // read, which is the same reuse the sweep depends on.
  const known = new Map<string, KnownContainer>(
    discovery.files.map((file) => [
      file.originKey,
      { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, containerPath: file.containerPath },
    ])
  );
  const perRoot: { root: string; files: number }[] = [];
  const independent = new Set<string>();
  for (const projectsRoot of projectsRoots) {
    const found = await discoverClaudeCodeTranscripts([projectsRoot], known);
    perRoot.push({ root: projectsRoot, files: found.files.length });
    for (const file of found.files) independent.add(file.filePath);
  }

  // Reuse the enumeration rather than paying for a third one. On a fresh
  // database the frontier is empty, so this is byte-for-byte what the sweep
  // would have discovered for itself.
  const sweep = await sweepFileSource(
    db,
    { ...source, discover: () => Promise.resolve(discovery) },
    new Date().toISOString()
  );
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
      `config=${config.path ?? '(none)'}`,
      `roots=${roots.length}`,
      `rootPaths=${roots.join(',')}`,
      `perRoot=${perRoot.map((entry) => `${entry.root}:${entry.files}`).join(',')}`,
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

  const swept = new Set(discovery.files.map((file) => file.filePath));
  const missed = [...independent].filter((file) => !swept.has(file));
  if (missed.length > 0) {
    problems.push(
      `${missed.length} files exist under a resolved root and were not indexed ` +
        `(first: ${missed[0]}) — the source is not reading every root`
    );
  }
  if (rebuildMs > MAX_REBUILD_MS)
    problems.push(`rebuildMs=${rebuildMs.toFixed(0)} is above ${MAX_REBUILD_MS}`);
  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
