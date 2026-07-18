#!/usr/bin/env -S node --import tsx
/**
 * `dorkos-evals` CLI — run an eval suite locally.
 *
 * Usage:
 *   dorkos-evals run --suite <name> --tier <tier> [--budget <usd>] [--out <dir>]
 *
 * Selects the suite's cases, runs each in its own sandbox + server under a
 * shared run budget, writes JSONL transcripts + `results.json`, prints a
 * pass/fail table, and exits non-zero on any non-quarantined failure.
 *
 * @module evals/bin
 */
import path from 'node:path';
import { RuntimeTierSchema, type RuntimeTier } from '../src/types.js';
import { selectSuite } from '../src/suite/index.js';
import { runSuite } from '../src/runner/run-suite.js';
import { formatSummaryTable, runGateFailed } from '../src/report/summary.js';

/** Parsed CLI flags. */
interface Cli {
  command: string;
  suite: string;
  tier: RuntimeTier;
  budgetUsd?: number;
  outDir: string;
  model?: string;
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
      const value = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      flags.set(key, value);
    }
  }
  const tier = RuntimeTierSchema.parse(flags.get('tier') ?? 'test-mode');
  const budget = flags.get('budget');
  return {
    command,
    suite: flags.get('suite') ?? 'smoke',
    tier,
    budgetUsd: budget !== undefined ? Number(budget) : undefined,
    outDir: flags.get('out') ?? path.join(process.cwd(), '.evals-runs'),
    model: flags.get('model'),
  };
}

/** Entry point: parse args, run the suite, print the table, set the exit code. */
async function main(): Promise<void> {
  const cli = parseArgs(process.argv.slice(2));
  if (cli.command !== 'run') {
    process.stderr.write(`Unknown command '${cli.command}'. Try: dorkos-evals run --suite smoke\n`);
    process.exitCode = 2;
    return;
  }

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
  });

  process.stdout.write(formatSummaryTable(summary) + '\n');
  process.stdout.write(`\nresults: ${resultsPath}\n`);
  process.exitCode = runGateFailed(summary) ? 1 : 0;
}

void main();
