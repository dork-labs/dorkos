/**
 * Rebuild the message-search index from this machine's real transcripts — Claude
 * Code's and Codex's — and print what it cost.
 *
 * Run it with:
 *
 * ```bash
 * DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-corpus-bench.ts
 * DORKOS_SEARCH_BENCH=1 pnpm tsx scripts/search-corpus-bench.ts --source codex
 * ```
 *
 * Each source is benched into its own throwaway database, so `messages=` on a
 * line means that source's messages and nothing else. `--source` narrows to one
 * leg; with no flag both run.
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
 *
 * **The codex leg counts both of the rollout's two message families itself**,
 * over the same files, with its own parser — never through the projection,
 * which is the thing under test. A rollout records every message TWICE, once as
 * a `response_item` and once as an `event_msg`, and the two ways that breaks
 * need two different gates:
 *
 * - **Doubling.** Reading BOTH families lands at 166% of the `response_item`
 *   count, so `indexed > responseItems` fails. That was verified by seeding the
 *   defect: 433 rows against 261 records, exit 1.
 * - **Reading the WRONG family.** This one nearly shipped unguarded, and the
 *   correction is worth stating rather than quietly fixing. An earlier version
 *   of this comment claimed the share floor below caught it. **It does not, and
 *   no share floor can**: the two families hold the SAME messages, so a
 *   projection reading `event_msg` lands at 219 — 84% of 261, comfortably
 *   inside any sane band, exit 0. What separates them is that the shipped
 *   projection's own gate makes its count differ from the other family's, so
 *   the discriminator is an EQUALITY against `codexEventFamily`: 214 ≠ 219,
 *   where a wrong-family read is 219 = 219 exactly.
 *
 * The share floor still earns its place for the third failure — a projection
 * that indexes almost nothing — but it is not the wrong-family gate and no
 * longer claims to be. The unit-test half of this guard is
 * `codex-projection.test.ts`'s two-families case, which asserts the BODIES are
 * the `response_item` texts rather than only counting rows.
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
import {
  createClaudeCodeSource,
  createCodexSource,
} from '../apps/server/src/services/search/registry.js';
import { discoverClaudeCodeTranscripts } from '../apps/server/src/services/search/claude-code-discovery.js';
import { discoverCodexRollouts } from '../apps/server/src/services/search/codex-discovery.js';
import { resolveClaudeRootSet } from '../apps/server/src/services/runtimes/claude-code/claude-config-dir.js';
import { resolveCodexRolloutRoots } from '../apps/server/src/services/runtimes/codex/codex-home.js';
import type {
  FileContainer,
  FileDiscovery,
  KnownContainer,
} from '../apps/server/src/services/search/types.js';

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

/**
 * The smallest share of a rollout's `response_item` message records that a
 * healthy Codex index may hold.
 *
 * **Derived rather than picked.** Measured 2026-08-25 on this machine: 18
 * rollouts hold **261** `response_item` message records and the index holds
 * **214** of them — **82%**. The other 47 are Codex's own `developer`-role
 * instructions (20), user records that are nothing but injected context (22),
 * and widget clicks carrying no words (5); `projections/codex.ts` breaks that
 * down. So the ratio is a property of how much plumbing a corpus carries, and a
 * floor at half leaves a corpus with twice this machine's proportion of plumbing
 * passing.
 *
 * A count would have been the wrong instrument for the same reason DOR-682 gave:
 * it is machine- and time-dependent while the property is neither.
 *
 * **What this floor does NOT catch, stated because an earlier version of this
 * comment claimed it did:** a projection reading the `event_msg` family instead.
 * Both families hold the same messages, so that read lands at 219 of 261 — 84%,
 * inside this band, exit 0. {@link wrongFamilyProblems} is the gate for it, and
 * no share floor could be.
 */
const MIN_CODEX_INDEXED_SHARE = 0.5;

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

/** One source this script can rebuild. */
type Leg = 'claude-code' | 'codex';

/**
 * The legs to run: `--source <id>`, or both when the flag is absent.
 *
 * An unknown id exits rather than silently running everything — a typo that
 * benches the wrong corpus is worse than a refusal.
 *
 * @param argv - Arguments after the script name.
 * @returns The legs, in registry order.
 */
function requestedLegs(argv: readonly string[]): Leg[] {
  const index = argv.indexOf('--source');
  if (index === -1) return ['claude-code', 'codex'];
  const requested = argv[index + 1];
  if (requested === 'claude-code' || requested === 'codex') return [requested];
  console.error(`--source takes 'claude-code' or 'codex'; got ${requested ?? '(nothing)'}`);
  process.exit(2);
}

const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-search-bench-'));

/**
 * A throwaway database for one leg.
 *
 * One per leg rather than one shared: `messages=` then means that source's
 * messages, with no `WHERE source_id` to get wrong, and `dbBytes=` is what that
 * source's index really costs.
 *
 * @param leg - Which source this database is for.
 * @returns The open database and its path.
 */
function openLegDb(leg: Leg): { db: ReturnType<typeof createDb>; dbPath: string } {
  const dbPath = path.join(workdir, `${leg}.db`);
  const db = createDb(dbPath);
  runMigrations(db);
  return { db, dbPath };
}

/**
 * Every page the index occupies, WAL included — the file alone understates it
 * while the database is still open.
 *
 * @param dbPath - Path the database was opened at.
 * @returns Total bytes across the database and its sidecars.
 */
function indexBytes(dbPath: string): number {
  return ['', '-wal', '-shm'].reduce(
    (total, suffix) =>
      total + (fs.statSync(`${dbPath}${suffix}`, { throwIfNoEntry: false })?.size ?? 0),
    0
  );
}

/**
 * What the frontier would have known about these files, had it seen them.
 *
 * Handed to the per-root re-enumeration so the second pass classifies an
 * unchanged file from what the first already learned rather than from a fresh
 * head read — the same reuse the sweep depends on.
 *
 * @param discovery - What the source's own discovery found.
 * @returns The known-container map, keyed by container id.
 */
function knownFrom(discovery: FileDiscovery): Map<string, KnownContainer> {
  return new Map(
    discovery.files.map((file) => [
      file.originKey,
      { sizeBytes: file.sizeBytes, mtimeMs: file.mtimeMs, containerPath: file.containerPath },
    ])
  );
}

/**
 * Files an independent per-root enumeration found that the source's own
 * discovery did not, as a problem line — or nothing when it read them all.
 *
 * @param discovery - What the source's own discovery found.
 * @param independent - Paths found by enumerating each root on its own.
 * @returns Zero or one problem.
 */
function coverageProblems(discovery: FileDiscovery, independent: ReadonlySet<string>): string[] {
  const swept = new Set(discovery.files.map((file) => file.filePath));
  const missed = [...independent].filter((file) => !swept.has(file));
  if (missed.length === 0) return [];
  return [
    `${missed.length} files exist under a resolved root and were not indexed ` +
      `(first: ${missed[0]}) — the source is not reading every root`,
  ];
}

/**
 * Rebuild the Claude Code half of the index and report what failed.
 *
 * @returns Problem lines; empty when the leg passed.
 */
async function benchClaudeCode(): Promise<string[]> {
  const roots = resolveClaudeRootSet(config.reader);
  const projectsRoots = roots.map((root) => path.join(root, 'projects'));
  const source = createClaudeCodeSource(() => projectsRoots);
  const { db, dbPath } = openLegDb('claude-code');

  // The clock starts before discovery: walking several roots IS part of what a
  // rebuild costs, and timing only the read would hide the term that scales
  // with the number of accounts.
  const started = process.hrtime.bigint();
  const discovery = await source.discover(new Map());

  // **The coverage check, cross-checked against an independent enumeration.**
  // A root set of length two that still reads only the first root satisfies any
  // `roots.length` assertion, so the count has to come from somewhere else:
  // each root is enumerated again on its own and the union compared.
  const known = knownFrom(discovery);
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

  console.log(
    [
      `source=claude-code`,
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
      `dbBytes=${indexBytes(dbPath)}`,
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
  problems.push(...coverageProblems(discovery, independent));
  if (rebuildMs > MAX_REBUILD_MS)
    problems.push(`rebuildMs=${rebuildMs.toFixed(0)} is above ${MAX_REBUILD_MS}`);
  return problems;
}

/**
 * Count, with this script's own parser, how many messages each of a rollout's
 * two families holds.
 *
 * Deliberately not reusing the projection: it is the thing under test, and an
 * oracle that calls it proves only that it agrees with itself.
 *
 * @param files - The rollouts the sweep read.
 * @returns The two counts, and any file that could not be read.
 */
function countRolloutFamilies(files: readonly FileContainer[]): {
  responseItemMessages: number;
  eventFamilyMessages: number;
  unreadable: number;
} {
  let responseItemMessages = 0;
  let eventFamilyMessages = 0;
  let unreadable = 0;

  for (const file of files) {
    let text: string;
    try {
      text = fs.readFileSync(file.filePath, 'utf8');
    } catch {
      unreadable += 1;
      continue;
    }
    // Split on `\n` alone, for the reason the frontier reader documents at
    // length: `readline` also breaks on U+2028/U+2029 and would tear real
    // records into fragments this count would then miss.
    for (const raw of text.split('\n')) {
      if (raw.trim() === '') continue;
      let record: { type?: unknown; payload?: unknown };
      try {
        record = JSON.parse(raw) as { type?: unknown; payload?: unknown };
      } catch {
        continue;
      }
      const payload = record.payload as { type?: unknown; role?: unknown } | undefined;
      if (payload === null || typeof payload !== 'object') continue;
      if (record.type === 'response_item' && payload.type === 'message') responseItemMessages += 1;
      if (
        record.type === 'event_msg' &&
        (payload.type === 'user_message' || payload.type === 'agent_message')
      ) {
        eventFamilyMessages += 1;
      }
    }
  }

  return { responseItemMessages, eventFamilyMessages, unreadable };
}

/**
 * Whether the index looks like it was built from the WRONG one of the rollout's
 * two message families.
 *
 * **An equality, and it has to be.** The `event_msg` family holds the same
 * messages as the `response_item` family, so a projection reading it produces a
 * plausible count — 219 of 261 on this machine, 84%, inside any share band
 * anybody would write. What distinguishes it is that the shipped projection
 * applies an authorship gate and the wrong-family read does not, so their counts
 * cannot coincide by accident: 214 against 219 here, and exactly 219 = 219 for
 * the defect. Verified by seeding it.
 *
 * **Its false positive is the DEFAULT on a widget-free corpus, not a
 * coincidence.** Measured per-file: the authorship gate and the event_msg
 * family exclude the same records except `<ui_action>` widget clicks, a
 * DorkOS generative-UI artifact — 17 of 18 files here already satisfy the
 * equality individually, and the corpus-level 214 != 219 comes entirely from
 * one session's seven clicks. A person using the plain codex CLI, or DorkOS
 * without gen-UI, gets equal counts and a spurious FAIL. That is survivable
 * because this script is run deliberately by a person who can read both
 * numbers off the line above — which is why the message prints them — and
 * because the projection unit suite (codex-projection.test.ts, the
 * two-families case) is the hard gate either way; this check is corroborating
 * evidence on corpora where the counts can differ at all.
 *
 * @param indexed - Messages the sweep actually wrote.
 * @param families - The two counts, taken with this script's own parser.
 * @returns Zero or one problem.
 */
function wrongFamilyProblems(
  indexed: number,
  families: { responseItemMessages: number; eventFamilyMessages: number }
): string[] {
  if (indexed !== families.eventFamilyMessages) return [];
  return [
    `messages=${indexed} equals the ${families.eventFamilyMessages} event_msg records in the ` +
      `same files (response_item holds ${families.responseItemMessages}) — the projection is ` +
      `reading the wrong family`,
  ];
}

/**
 * Rebuild the Codex half of the index and report what failed.
 *
 * @returns Problem lines; empty when the leg passed.
 */
async function benchCodex(): Promise<string[]> {
  const rolloutRoots = resolveCodexRolloutRoots();
  const source = createCodexSource(() => rolloutRoots);
  const { db, dbPath } = openLegDb('codex');

  const started = process.hrtime.bigint();
  const discovery = await source.discover(new Map());

  const known = knownFrom(discovery);
  const perRoot: { root: string; files: number }[] = [];
  const independent = new Set<string>();
  for (const root of rolloutRoots) {
    const found = await discoverCodexRollouts([root], known);
    perRoot.push({ root, files: found.files.length });
    for (const file of found.files) independent.add(file.filePath);
  }

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
    .where(eq(searchSources.sourceId, 'codex'))
    .all().length;
  const families = countRolloutFamilies(discovery.files);

  console.log(
    [
      `source=codex`,
      `rootPaths=${rolloutRoots.join(',')}`,
      `perRoot=${perRoot.map((entry) => `${entry.root}:${entry.files}`).join(',')}`,
      `files=${sweep.containers}`,
      `containers=${containers}`,
      `messages=${indexed}`,
      `codexResponseItems=${families.responseItemMessages}`,
      `codexEventFamily=${families.eventFamilyMessages}`,
      `skippedLines=${sweep.skipped}`,
      `skippedFiles=${discovery.skipped.length}`,
      `failures=${sweep.failures.length}`,
      `rebuildMs=${rebuildMs.toFixed(0)}`,
      `dbBytes=${indexBytes(dbPath)}`,
    ].join(' ')
  );

  for (const failure of sweep.failures.slice(0, 10)) {
    console.error(`  failed: ${failure.originKey} — ${failure.message}`);
  }

  const problems: string[] = [];

  // A machine with no Codex is not a failure, and asserting a floor here would
  // red on every one of them. Say so and assert nothing.
  if (discovery.files.length === 0) {
    console.log('  codex: no rollout files on this machine — nothing asserted');
    return problems;
  }

  if (families.unreadable > 0) {
    problems.push(`${families.unreadable} rollouts could not be re-read for the cross-check`);
  }
  // **The double-count gate.** The index cannot hold more messages than the
  // family it reads has records; a projection reading BOTH families lands at
  // 166% of this (measured, by seeding exactly that defect) and fails here.
  if (indexed > families.responseItemMessages) {
    problems.push(
      `messages=${indexed} exceeds the ${families.responseItemMessages} response_item message ` +
        `records in the same files — the projection is reading both families`
    );
  }
  problems.push(...wrongFamilyProblems(indexed, families));
  // The third failure: a projection that indexes almost nothing. Deliberately
  // NOT the wrong-family gate — see this constant's own note.
  if (indexed < families.responseItemMessages * MIN_CODEX_INDEXED_SHARE) {
    problems.push(
      `messages=${indexed} is below ${(MIN_CODEX_INDEXED_SHARE * 100).toFixed(0)}% of the ` +
        `${families.responseItemMessages} response_item message records in the same files`
    );
  }
  problems.push(...coverageProblems(discovery, independent));
  if (rebuildMs > MAX_REBUILD_MS)
    problems.push(`rebuildMs=${rebuildMs.toFixed(0)} is above ${MAX_REBUILD_MS}`);
  return problems;
}

try {
  const problems: string[] = [];
  for (const leg of requestedLegs(process.argv.slice(2))) {
    problems.push(...(leg === 'claude-code' ? await benchClaudeCode() : await benchCodex()));
  }
  if (problems.length > 0) {
    console.error(`\nFAIL: ${problems.join('; ')}`);
    process.exit(1);
  }
} finally {
  fs.rmSync(workdir, { recursive: true, force: true });
}
