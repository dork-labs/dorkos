#!/usr/bin/env -S node --import tsx
/**
 * `dorkos-evals` CLI — run an eval suite locally, or sweep what a previous run
 * left behind.
 *
 * Usage:
 *   dorkos-evals run --suite <name> --tier <tier> [--budget <usd>] [--out <dir>]
 *                    [--isolation auto|child-process|docker]
 *   dorkos-evals sweep [--dry-run] [--force]
 *
 * `run` selects the suite's cases, runs each in its own sandbox + server under a
 * shared run budget, writes JSONL transcripts + `results.json`, prints a
 * pass/fail table, and exits non-zero when the run's gate fails — including when
 * the run gated on NO cases at all (every selected case quarantined), which
 * otherwise looks exactly like a pass.
 *
 * `sweep` removes stray eval sandboxes and eval containers (see
 * `runner/sweep.ts`). It leaves RUNNING containers alone unless `--force`, so
 * sweeping while a background eval is mid-turn cannot kill it.
 *
 * `--isolation` picks how a CREDENTIALED eval's server is contained: `auto`
 * (default) containerizes only the cases that ask for it, `docker` containerizes
 * every one, `child-process` never does. Without a reachable docker daemon and
 * eval image the run degrades to child-process with a message, never a failure.
 *
 * A credentialed tier reaches a model through `ANTHROPIC_API_KEY`, or
 * `CLAUDE_CODE_OAUTH_TOKEN`, or the `claude` sign-in on this machine — in that
 * order, and the run prints which one answered. Being signed in is enough to run
 * locally; see `packages/evals/README.md`. The docker tier is the exception: a
 * container cannot see the local sign-in, so it needs one of the two variables.
 *
 * @module evals/bin
 */
import path from 'node:path';
import { RuntimeTierSchema, type RuntimeTier } from '../src/types.js';
import { selectSuite } from '../src/suite/index.js';
import { runSuite } from '../src/runner/run-suite.js';
import { sweepStrays, formatSweepReport } from '../src/runner/sweep.js';
import { parseBudgetUsd, VALUELESS_FLAG } from '../src/runner/budget.js';
import {
  parseIsolationTier,
  type IsolationTier,
} from '../src/runner/isolation/resolve-launcher.js';
import { formatSummaryTable, evaluateRunGate } from '../src/report/summary.js';

/** Parsed CLI flags. */
interface Cli {
  command: string;
  suite: string;
  tier: RuntimeTier;
  budgetUsd?: number;
  outDir: string;
  model?: string;
  isolation: IsolationTier;
  dryRun: boolean;
  force: boolean;
}

/** Read `--flag value` pairs (and the optional leading command) out of argv. */
function parseArgs(rawArgv: string[]): Cli {
  // Drop the bare `--` pnpm forwards between `run evals` and the script flags.
  const argv = rawArgv.filter((a) => a !== '--');
  // A leading non-flag token is the command; otherwise `run` is implicit.
  const command = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'run';
  const start = argv[0] && !argv[0].startsWith('--') ? 1 : 0;
  const flags = new Map<string, string>();
  for (let i = start; i < argv.length; i++) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : VALUELESS_FLAG;
      flags.set(key, value);
    }
  }
  const tier = RuntimeTierSchema.parse(flags.get('tier') ?? 'test-mode');
  const budgetUsd = parseBudgetUsd(flags.get('budget'));
  return {
    command,
    suite: flags.get('suite') ?? 'smoke',
    tier,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    outDir: flags.get('out') ?? path.join(process.cwd(), '.evals-runs'),
    model: flags.get('model'),
    isolation: parseIsolationTier(flags.get('isolation')),
    dryRun: flags.get('dry-run') !== undefined,
    force: flags.get('force') !== undefined,
  };
}

/** Run the selected suite and set the exit code from its gate verdict. */
async function runCommand(cli: Cli): Promise<void> {
  const cases = selectSuite(cli.suite);
  if (cases.length === 0) {
    process.stderr.write(`No eval cases matched suite '${cli.suite}'.\n`);
    process.exitCode = 2;
    return;
  }

  const { summary, resultsPath } = await runSuite(cases, {
    tier: cli.tier,
    budgetUsd: cli.budgetUsd,
    outDir: cli.outDir,
    model: cli.model,
    isolation: cli.isolation,
  });

  process.stdout.write(formatSummaryTable(summary) + '\n');
  process.stdout.write(`\nresults: ${resultsPath}\n`);

  const gate = evaluateRunGate(summary);
  if (gate.failed) {
    process.stderr.write(`\nEVAL GATE FAILED: ${gate.reason ?? 'unknown reason'}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = 0;
}

/** Sweep stray sandboxes and containers a previous run left behind. */
async function sweepCommand(cli: Cli): Promise<void> {
  const report = await sweepStrays({ dryRun: cli.dryRun, force: cli.force });
  process.stdout.write(formatSweepReport(report, cli.dryRun) + '\n');
  process.exitCode = 0;
}

/** Entry point: parse args, dispatch the command, set the exit code. */
async function main(): Promise<void> {
  let cli: Cli;
  try {
    cli = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 2;
    return;
  }

  if (cli.command === 'run') return runCommand(cli);
  if (cli.command === 'sweep') return sweepCommand(cli);

  process.stderr.write(
    `Unknown command '${cli.command}'. Try: dorkos-evals run --suite smoke, or dorkos-evals sweep\n`
  );
  process.exitCode = 2;
}

void main();
