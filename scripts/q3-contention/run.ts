/**
 * Entry point for the Q3 contention harness (DOR-500).
 *
 *   pnpm q3:contention --arm 1
 *   pnpm q3:contention --arm 2
 *   pnpm q3:contention --arm 3          # real runtimes; costs real tokens
 *   pnpm q3:contention --arm 1 --smoke  # plumbing check, NOT data
 *
 * It answers ONE question: at 2 humans and 6 agents on one machine, which
 * resource class collides first — the working tree, `~/.dork` SQLite, file
 * descriptors and watchers, runtime subprocess memory, or provider rate limits?
 *
 * The run: provision throwaway state inside the OS temp dir → boot a throwaway
 * server against it → fire every agent's turn concurrently → sample the machine
 * at 1 Hz → PROVE the turns overlapped → count what survived in the canary →
 * tear everything down. The overlap proof is not optional: without it a clean
 * result is indistinguishable from agents politely taking turns.
 *
 * The harness reports numbers. It does not interpret them.
 *
 * @module scripts/q3-contention/run
 */
import { promises as fs } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { buildCanaryReport, type CanaryReport } from './canary.js';
import {
  assertOverlap,
  assertTurnsDidWork,
  computeOverlap,
  type OverlapReport,
} from './overlap.js';
import { parseArgs, USAGE, type RunPlan } from './plan.js';
import { provision, teardownRunRoot, type RunPaths } from './provision.js';
import { Sampler, type Sample } from './sampler.js';
import {
  bootServer,
  buildServerDeps,
  ERROR_DETECTION_SCOPE,
  SQLITE_SCOPE,
  type ServerHandle,
} from './server-process.js';
import { fireConcurrentTurns, MutableTurnTracker, type TurnResult } from './turns.js';

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/** Render rows as CSV with the given column order. */
function toCsv<T>(rows: readonly T[], columns: readonly (keyof T & string)[]): string {
  const escape = (value: unknown): string => {
    const text = String(value ?? '');
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [columns.join(',')];
  for (const row of rows) lines.push(columns.map((column) => escape(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

const SAMPLE_COLUMNS = [
  'iso',
  'tMs',
  'load1',
  'load5',
  'load15',
  'procCount',
  'rssTreeKb',
  'rssServerKb',
  'openFiles',
  'maxFiles',
  'sqliteBusy',
  'emfile',
  'turnsRunning',
  'turnsEnded',
  'terminalOutcomes',
] as const satisfies readonly (keyof Sample)[];

const TURN_COLUMNS = [
  'index',
  'vocab',
  'tree',
  'sessionId',
  'firedAtMs',
  'firstDeltaAtMs',
  'observedEndMs',
  'startedAtMs',
  'endedAtMs',
  'timestampSource',
  'terminalReason',
  'ticks',
  'appends',
  'canaryErrors',
  'crossedTokens',
] as const satisfies readonly (keyof TurnResult)[];

/** Copy each canary out of the throwaway tree and account for its survivors. */
async function collectCanaries(
  plan: RunPlan,
  paths: RunPaths,
  turns: readonly TurnResult[]
): Promise<CanaryReport[]> {
  const reports: CanaryReport[] = [];
  for (const tree of plan.trees) {
    const canaryPath = paths.canaries[tree];
    let text = '';
    try {
      text = await fs.readFile(canaryPath, 'utf8');
    } catch {
      // A missing canary is itself a result: reported as zero survivors.
    }
    await fs.writeFile(path.join(paths.outDir, `canary-${tree}.log`), text, 'utf8');
    const reported: Record<string, number> = {};
    for (const turn of turns) {
      if (turn.tree === tree && turn.appends >= 0) reported[turn.vocab] = turn.appends;
    }
    reports.push(buildCanaryReport(canaryPath, text, reported));
  }
  return reports;
}

/** Print the run's headline numbers without interpreting them. */
function printSummary(
  plan: RunPlan,
  overlap: OverlapReport,
  turns: readonly TurnResult[],
  canaries: readonly CanaryReport[],
  samples: readonly Sample[],
  server: ServerHandle,
  outDir: string
): void {
  const peakLoad = samples.reduce((max, s) => Math.max(max, s.load1), 0);
  const peakRss = samples.reduce((max, s) => Math.max(max, s.rssTreeKb), 0);
  const peakFds = samples.reduce((max, s) => Math.max(max, s.openFiles), 0);

  console.log('');
  if (plan.smoke) {
    console.log('[q3] SMOKE RUN — plumbing check only. These numbers are NOT data.');
  }
  console.log(`[q3] arm ${plan.arm}  agents=${plan.agents.length}  trees=${plan.trees.join(',')}`);
  console.log(
    `[q3] overlap: all-overlap=${overlap.allOverlap} commonWindow=${overlap.commonWidthMs}ms ` +
      `minPairwise=${overlap.minPairwiseOverlapMs}ms`
  );
  console.log(
    `[q3] turns: ${turns.map((t) => `${t.vocab}=${t.terminalReason}`).join(' ')}  ` +
      `crossedTokens=${turns.reduce((sum, t) => sum + t.crossedTokens, 0)}`
  );
  for (const canary of canaries) {
    console.log(
      `[q3] canary ${path.basename(path.dirname(canary.path))}: reported=${canary.reportedTotal} ` +
        `survived=${canary.survivedTotal} missing=${canary.missingTotal} ` +
        `malformed=${canary.malformedLines}`
    );
  }
  if (canaries.length > 0) {
    console.log('[q3] canary numbers are an INTERLEAVE count, not a corruption rate — see');
    console.log('[q3]   research/20260725_q3-contention-preregistration.md before quoting them.');
  }
  console.log(
    `[q3] machine: peakLoad1=${peakLoad.toFixed(2)} peakTreeRss=${Math.round(peakRss / 1024)}MB ` +
      `peakOpenFiles=${peakFds} sqliteBusy=${server.counters.sqliteBusy} emfile=${server.counters.emfile}`
  );
  console.log('[q3]   sqliteBusy covers ONE process’s pool (intra-process contention only).');
  console.log(`[q3] samples=${samples.length}  artifacts=${outDir}`);
  console.log('');
}

/** Verdicts from the two validity proofs, recorded whether or not they passed. */
interface Validity {
  readonly overlap: OverlapReport | undefined;
  /** Why the run is invalid, or undefined when both proofs passed. */
  readonly invalidReason: string | undefined;
}

/**
 * Run both validity proofs without throwing, so the verdict can be written into
 * `summary.json` before the run is failed. `computeOverlap` itself throws on a
 * degenerate interval — reachable whenever an SSE stream drops and `endedAtMs`
 * stays 0 — so it is guarded here rather than left to strand the teardown.
 */
function checkValidity(plan: RunPlan, turns: readonly TurnResult[]): Validity {
  let overlap: OverlapReport | undefined;
  try {
    overlap = computeOverlap(
      turns.map((t) => ({ label: t.vocab, startMs: t.startedAtMs, endMs: t.endedAtMs }))
    );
    assertOverlap(overlap, plan.minOverlapMs);
    assertTurnsDidWork(
      turns.map((t) => ({
        label: t.vocab,
        terminalReason: t.terminalReason,
        ticks: t.ticks,
        appends: t.appends,
      })),
      plan.agents.map((a) => a.vocab)
    );
  } catch (err) {
    return { overlap, invalidReason: err instanceof Error ? err.message : String(err) };
  }
  return { overlap, invalidReason: undefined };
}

/** Provision, run, measure, and tear down one arm. */
async function runArm(plan: RunPlan): Promise<void> {
  const paths = await provision(plan, REPO_ROOT);
  console.log(`[q3] run root  ${paths.runRoot}`);
  console.log(`[q3] dork home ${paths.dorkHome}`);
  console.log(`[q3] trees     ${plan.trees.map((t) => paths.trees[t]).join(' ')}`);
  console.log(`[q3] output    ${paths.outDir}`);

  if (!plan.skipBuild) {
    console.log('[q3] building @dorkos/server…');
    await buildServerDeps(REPO_ROOT);
  }

  const tracker = new MutableTurnTracker();
  let server: ServerHandle | undefined;
  let sampler: Sampler | undefined;
  let turns: TurnResult[] = [];
  let failure: unknown;
  // No initializers on these three, unlike `turns` above, and the asymmetry is
  // real rather than an oversight: the inner catch below swallows into
  // `failure` and lets execution continue, so all three are unconditionally
  // reassigned (`samples`, then `canaries` and `validity`) before anything
  // reads them — a default here would be dead on every path. `turns` keeps its
  // `[]` because it IS read at that default, by the `turns.csv` write, whenever
  // the boot or the turns themselves threw.
  let validity: Validity;
  let canaries: CanaryReport[];
  let samples: readonly Sample[];

  // Everything from the first spawn onward sits inside try/finally: a throw
  // between here and teardown would otherwise strand a live server holding the
  // port and leave an undeleted run root behind, which on a shared machine is a
  // real nuisance rather than a theoretical one.
  try {
    try {
      server = await bootServer(plan, paths, REPO_ROOT, path.join(paths.outDir, 'server.log'));
      console.log(`[q3] server up on ${server.baseUrl} (pid ${server.pid})`);

      sampler = new Sampler(server.pid, server.counters, tracker);
      sampler.start();

      turns = await fireConcurrentTurns(plan, paths, server.baseUrl, tracker);
    } catch (err) {
      failure = err;
    }

    await sampler?.stop();
    samples = sampler?.rows() ?? [];

    // Artifacts are written BEFORE the run is failed, so a discarded run still
    // leaves its evidence — including WHY it was discarded.
    await fs.writeFile(path.join(paths.outDir, 'samples.csv'), toCsv(samples, SAMPLE_COLUMNS));
    await fs.writeFile(path.join(paths.outDir, 'turns.csv'), toCsv(turns, TURN_COLUMNS));

    canaries = turns.length > 0 ? await collectCanaries(plan, paths, turns) : [];
    validity =
      turns.length >= 2
        ? checkValidity(plan, turns)
        : { overlap: undefined, invalidReason: '[q3] run produced fewer than two turns' };

    await fs.writeFile(
      path.join(paths.outDir, 'summary.json'),
      `${JSON.stringify(
        {
          preRegistration: 'research/20260725_q3-contention-preregistration.md',
          plan,
          runRoot: paths.runRoot,
          valid: failure === undefined && validity.invalidReason === undefined,
          invalidReason: validity.invalidReason,
          overlap: validity.overlap,
          turns,
          canaries,
          errorCounters: server?.counters ?? { sqliteBusy: 0, emfile: 0 },
          // The counters above are meaningless without these two. They travel
          // in the same object so a bare `sqliteBusy: 0` cannot be lifted out
          // and read as "SQLite is fine under multi-agent load".
          errorCounterScope: {
            sqliteBusy: SQLITE_SCOPE,
            detection: ERROR_DETECTION_SCOPE,
          },
          sampleCount: samples.length,
          skippedSamples: sampler?.skippedTicks() ?? 0,
        },
        null,
        2
      )}\n`
    );
  } finally {
    // Neither teardown may mask the failure that brought us here, and a failure
    // in one must not skip the other.
    try {
      await server?.stop();
    } catch (err) {
      console.error(`[q3] server teardown failed: ${err instanceof Error ? err.message : err}`);
    }
    try {
      await teardownRunRoot(paths, REPO_ROOT, plan.keepRunRoot);
    } catch (err) {
      console.error(`[q3] run-root teardown failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  if (failure) throw failure;
  if (validity.overlap && server) {
    printSummary(plan, validity.overlap, turns, canaries, samples, server, paths.outDir);
  }
  // Last, so every artifact is on disk and everything is reaped before a failed
  // proof aborts the run.
  if (validity.invalidReason) throw new Error(validity.invalidReason);
}

/** Parse argv, run the selected arm, and set a non-zero exit code on failure. */
async function main(): Promise<void> {
  let plan: RunPlan | null;
  try {
    plan = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    console.error('');
    console.error(USAGE);
    process.exitCode = 1;
    return;
  }
  if (!plan) {
    console.log(USAGE);
    return;
  }
  if (plan.arm === 3) {
    console.log('[q3] arm 3 drives REAL runtimes — this run costs real tokens.');
  }
  try {
    await runArm(plan);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  }
}

await main();
