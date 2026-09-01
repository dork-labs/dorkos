#!/usr/bin/env -S node --import tsx
/**
 * `dorkos-evals` CLI — run an eval suite locally, or sweep what a previous run
 * left behind.
 *
 * Usage:
 *   dorkos-evals run --suite <name> --tier <tier> [--budget <usd>] [--out <dir>]
 *                    [--runtime claude-code|codex|opencode] [--provider <id>]
 *                    [--model <id>] [--isolation auto|child-process|docker]
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
 * `--runtime` picks which agent runtime owns every session the run creates, and
 * `--provider` / `--model` say which model that runtime should answer with. The
 * `real-provider` tier defaults the triple to
 * `--runtime opencode --provider openrouter --model openrouter/qwen/qwen3.7-flash`.
 *
 * A credentialed tier reaches a model through `ANTHROPIC_API_KEY`, or
 * `CLAUDE_CODE_OAUTH_TOKEN`, or the `claude` sign-in on this machine — in that
 * order, and the run prints which one answered. Being signed in is enough to run
 * locally; see `packages/evals/README.md`. The docker tier is the exception: a
 * container cannot see the local sign-in, so it needs one of the two variables.
 *
 * ANY run that reaches an external provider spends OUTSIDE a Claude
 * subscription, and needs two deliberate acts: `DORKOS_EVALS_PAID_PROVIDER=1`
 * AND `OPENROUTER_API_KEY`. That is `--tier real-provider`, and equally
 * `--runtime opencode` or `--provider <id>` on ANY tier — the gate follows what
 * the run reaches, not the tier name (`spendsOnExternalProvider` in
 * `src/runner/credentials.ts`, which exists because keying it on the tier let a
 * cheap-tier OpenCode run spend with the flag unset). Without the flag the run
 * stops before it boots anything (exit 2, nothing billed); with the flag and no
 * key every case is a runner error, never a pass. Such a run also refuses
 * `--isolation docker`, whose containers have no network at all.
 *
 * @module evals/bin
 */
import path from 'node:path';
import {
  EvalRuntimeSchema,
  RuntimeTierSchema,
  type EvalRuntime,
  type RuntimeTier,
} from '../src/types.js';
import { selectSuite } from '../src/suite/index.js';
import { PaidTierRefusedError, runSuite } from '../src/runner/run-suite.js';
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
  runtime?: EvalRuntime;
  provider?: string;
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
  // Parsed rather than passed through: an unknown runtime would otherwise reach
  // the server as a `runtime` hint and come back as a 400 on the first turn of
  // every case, which reads as a harness fault rather than a typo.
  const rawRuntime = flags.get('runtime');
  const runtime = rawRuntime !== undefined ? EvalRuntimeSchema.parse(rawRuntime) : undefined;
  return {
    command,
    suite: flags.get('suite') ?? 'smoke',
    tier,
    ...(budgetUsd !== undefined ? { budgetUsd } : {}),
    outDir: flags.get('out') ?? path.join(process.cwd(), '.evals-runs'),
    model: flags.get('model'),
    ...(runtime ? { runtime } : {}),
    provider: flags.get('provider'),
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
    ...(cli.runtime ? { runtime: cli.runtime } : {}),
    ...(cli.provider ? { provider: cli.provider } : {}),
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

  if (cli.command === 'run') {
    try {
      return await runCommand(cli);
    } catch (err) {
      // A refusal is not a run that failed — nothing booted, nothing was billed,
      // and there is no results.json to point at. Print the reason plainly and
      // exit 2 (a usage problem), never 1 (a failing gate).
      if (err instanceof PaidTierRefusedError) {
        process.stderr.write(`${err.message}\n`);
        process.exitCode = 2;
        return;
      }
      throw err;
    }
  }
  if (cli.command === 'sweep') return sweepCommand(cli);

  process.stderr.write(
    `Unknown command '${cli.command}'. Try: dorkos-evals run --suite smoke, or dorkos-evals sweep\n`
  );
  process.exitCode = 2;
}

void main();
