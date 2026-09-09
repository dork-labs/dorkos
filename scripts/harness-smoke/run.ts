/**
 * `scripts/harness-smoke/run.sh <claude|codex|opencode>` — the H tier.
 *
 * Nothing in this repository had ever run a real harness binary against the
 * projection engine's output. Every green test is a claim about file SHAPE,
 * which is how the Codex hooks file stayed the wrong shape through four test
 * files that all asserted the engine's own bytes (HK-01). This runner stages a
 * fixture through the journey DSL, applies the real projection, and then asks
 * the binary itself what it found.
 *
 * ## The money rule
 *
 * This is the FOURTH path in the repo that can spend real money, and it has the
 * same shape as the other three (`AGENTS.md`, "Four paths in the repo spend real
 * money"): the flag `DORKOS_HARNESS_SMOKE=1` is the decision, a per-harness key
 * is the instrument, a key alone arms nothing, and an ambient sign-in is never
 * an instrument. `./gate.ts` is where that is enforced and why. Everything below
 * runs only after the gate said yes.
 *
 * ## What it never does
 *
 * - It never writes outside the fixture's own temp directory and the report
 *   directory. The binary is launched with `HOME` pointed at an empty sandbox,
 *   so even a harness that decided to write to its user config cannot reach the
 *   operator's.
 * - It never runs in CI, and none of its variable names may reach a turbo task.
 *   `packages/evals/src/runner/__tests__/paid-provider.test.ts` walks the whole
 *   parsed `turbo.json` for them.
 * - It never retries. One turn per harness, and a failure is a report.
 *
 * @module harness-smoke/run
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveSmokeGate } from './gate.js';
import { INSTRUCTIONS_SENTINEL, stageSmokeFixture } from './fixture.js';
import {
  SMOKE_HARNESS_IDS,
  smokeHarnessFor,
  type ListingObservation,
  type ProbeCommand,
  type SmokeHarness,
  type TurnObservation,
} from './harnesses.js';
import {
  activationVerdicts,
  calibrationVerdict,
  ceilingVerdict,
  credentialVerdict,
  listingVerdicts,
  overallStatus,
  sentinelVerdict,
  type Verdict,
} from './oracles.js';
import { armLine, renderRunReport, renderSkipReport, reportFileName } from './report.js';

/**
 * The default ceiling, in USD.
 *
 * A tripwire for a runaway loop, not an allowance: one turn against the fixture
 * costs fractions of a cent, so reaching this means something looped. The same
 * number the evals runner's paid tier uses, for the same reason.
 */
export const DEFAULT_MAX_USD = 0.5;

/** How long a single probe may take before the run gives up on it. */
const PROBE_TIMEOUT_MS = 300_000;

/** What the command line asked for. */
export interface SmokeOptions {
  /** The harness word. */
  harness: string;
  /** The per-run ceiling in USD. */
  maxUsd: number;
  /** Where the report is written. */
  reportDir: string;
  /** An explicit binary path, for a harness `PATH` does not name. */
  binary?: string;
}

/**
 * Parse the command line.
 *
 * Rejects a ceiling that is not a positive finite number rather than coercing
 * it: `--max-usd ""` becoming `0` would refuse every run, and `--max-usd abc`
 * becoming `NaN` would compare false against every cost and refuse nothing —
 * the second is the dangerous one.
 *
 * @param argv - arguments after the script name.
 * @param defaultReportDir - where reports go when `--report` is absent.
 * @returns the options, or a usage error to print.
 */
export function parseArgs(
  argv: readonly string[],
  defaultReportDir: string
): { ok: true; options: SmokeOptions } | { ok: false; error: string } {
  const [harness, ...rest] = argv;
  if (harness === undefined || harness.startsWith('-')) {
    return {
      ok: false,
      error: `Usage: run.sh <${SMOKE_HARNESS_IDS.join('|')}> [--max-usd N] [--report DIR] [--binary PATH]`,
    };
  }
  if (!smokeHarnessFor(harness)) {
    return {
      ok: false,
      error: `Unknown harness \`${harness}\`. Known: ${SMOKE_HARNESS_IDS.join(', ')}.`,
    };
  }

  let maxUsd = DEFAULT_MAX_USD;
  let reportDir = defaultReportDir;
  let binary: string | undefined;

  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    const value = rest[index + 1];
    if (flag === '--max-usd') {
      const parsed = Number(value);
      if (value === undefined || !Number.isFinite(parsed) || parsed <= 0) {
        return { ok: false, error: `--max-usd needs a positive number, got \`${value ?? ''}\`.` };
      }
      maxUsd = parsed;
      index += 1;
    } else if (flag === '--report') {
      if (value === undefined) return { ok: false, error: '--report needs a directory.' };
      reportDir = resolve(value);
      index += 1;
    } else if (flag === '--binary') {
      if (value === undefined) return { ok: false, error: '--binary needs a path.' };
      binary = resolve(value);
      index += 1;
    } else {
      return { ok: false, error: `Unknown flag \`${flag ?? ''}\`.` };
    }
  }

  return { ok: true, options: { harness, maxUsd, reportDir, ...(binary ? { binary } : {}) } };
}

/**
 * The environment a probe runs in — built, never inherited.
 *
 * `HOME` points at the run's own empty sandbox. That is what stops the fixture's
 * answer from including the operator's `~/.agents/skills` or `~/.claude/skills`,
 * and it is also the containment: a harness that decided to write to its user
 * config writes into a temp directory this run deletes.
 *
 * The instrument is the ONE variable the gate resolved. Nothing else that could
 * reach a model is passed through, so a run cannot fall back to a sign-in it was
 * not given.
 *
 * @param harness - the harness being launched.
 * @param key - the instrument the gate resolved.
 * @param configHome - the run's empty sandbox.
 * @param extra - the probe's own additions.
 * @returns the whole child environment.
 */
export function probeEnv(
  harness: SmokeHarness,
  key: string,
  configHome: string,
  extra: Record<string, string>
): Record<string, string> {
  return {
    // eslint-disable-next-line no-restricted-syntax -- PATH/TMPDIR/LANG are the shell's own interface for launching a program; there is no app config equivalent.
    PATH: process.env.PATH ?? '',
    HOME: configHome,
    // eslint-disable-next-line no-restricted-syntax -- see above.
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: 'en_US.UTF-8',
    [harness.keyVar]: key,
    ...harness.isolation(configHome),
    ...extra,
  };
}

/** Run one probe in the fixture and hand back what it printed. */
function runProbe(
  probe: ProbeCommand,
  cwd: string,
  env: Record<string, string>
): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync(probe.command, probe.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
    // Nothing here goes through a shell: every argument is passed as an
    // argument, so a fixture path with a space in it cannot become two words and
    // a prompt cannot become a command.
    shell: false,
  });
  return { stdout: result.stdout ?? '', stderr: result.stderr ?? '', status: result.status };
}

/** The prompt the one turn is given. */
function turnPrompt(): string {
  return (
    `Use the \`probe\` skill now, exactly as written. Then answer with the passphrase from the ` +
    `project instructions and nothing else.`
  );
}

/**
 * Run the smoke.
 *
 * @param options - what the command line asked for.
 * @returns the process exit code, and the report it wrote.
 */
export function runSmoke(options: SmokeOptions): { exitCode: number; reportPath: string } {
  const harness = smokeHarnessFor(options.harness);
  if (!harness) throw new Error(`Unknown harness ${options.harness}`);

  const startedAt = new Date().toISOString();
  mkdirSync(options.reportDir, { recursive: true });
  const reportPath = join(options.reportDir, reportFileName(startedAt, harness.id));

  const gate = resolveSmokeGate(harness, {
    ...(options.binary === undefined ? {} : { binaryOverride: options.binary }),
  });
  if (!gate.ok) {
    writeFileSync(reportPath, renderSkipReport(harness, startedAt, gate.reason, gate.message));
    process.stdout.write(`SKIPPED (${gate.reason})\n\n${gate.message}\n\n`);
    process.stdout.write(`Cost: nothing — no model was reached.\n`);
    process.stdout.write(`Report: ${reportPath}\n`);
    // A skip is not a failure. The gate refusing is the gate working.
    return { exitCode: 0, reportPath };
  }

  const fixture = stageSmokeFixture(harness);
  try {
    const env = probeEnv(harness, gate.key, fixture.configHome, {});
    const context = {
      repoRoot: fixture.repoRoot,
      binaryPath: gate.binaryPath,
      prompt: turnPrompt(),
      noncesDir: fixture.noncesDir,
      maxUsd: options.maxUsd,
    };

    let listing: ListingObservation | undefined;
    if (harness.listingProbe && harness.parseListing) {
      const probe = harness.listingProbe(context);
      const result = runProbe(probe, fixture.repoRoot, { ...env, ...probe.env });
      listing = harness.parseListing(result.stdout);
    }

    const turnProbe = harness.turnProbe(context);
    const turnResult = runProbe(turnProbe, fixture.repoRoot, { ...env, ...turnProbe.env });
    const turn: TurnObservation = harness.parseTurn(turnResult.stdout);
    listing ??= turn.listing;

    const calibration = calibrationVerdict(harness, fixture.repoRoot, listing);
    const verdicts: Verdict[] = [
      ...listingVerdicts(harness, listing, fixture.repoRoot),
      ...activationVerdicts(
        harness,
        fixture.authoredHookNonce,
        fixture.pluginHookNonce,
        fixture.skillNonce
      ),
      sentinelVerdict(harness, turn.text, INSTRUCTIONS_SENTINEL),
      credentialVerdict(harness, turn),
      ceilingVerdict(harness, turn, options.maxUsd),
      calibration.verdict,
    ];

    const report = renderRunReport({
      harness,
      startedAt,
      maxUsd: options.maxUsd,
      verdicts,
      calibration: calibration.findings,
      applied: fixture.applied,
      ...(turn.costUsd === undefined ? {} : { costUsd: turn.costUsd }),
      turnCommand: [turnProbe.command, ...turnProbe.args].join(' '),
    });
    writeFileSync(reportPath, report);

    const status = overallStatus(verdicts);
    for (const verdict of verdicts) {
      process.stdout.write(`${verdict.status.toUpperCase().padEnd(8)}${verdict.id}\n`);
    }
    process.stdout.write(
      `\nCost: ${
        turn.costUsd === undefined
          ? `not reported by ${harness.label}`
          : `${turn.costUsd.toFixed(4)} USD`
      } (ceiling ${options.maxUsd} USD)\n`
    );
    process.stdout.write(`Report: ${reportPath}\n`);
    if (turnResult.status !== 0) {
      // A null status means the child was killed — almost always the probe
      // timeout — and "exited null" would send somebody hunting for an exit code
      // that never existed.
      process.stdout.write(
        turnResult.status === null
          ? `Note: the turn never exited on its own; it was killed after ${PROBE_TIMEOUT_MS / 1000}s. ` +
              `stderr:\n${turnResult.stderr}\n`
          : `Note: the turn exited ${String(turnResult.status)}. stderr:\n${turnResult.stderr}\n`
      );
    }
    return { exitCode: status === 'failed' ? 1 : 0, reportPath };
  } finally {
    fixture.cleanup();
  }
}

/**
 * The entry point `run.sh` calls.
 *
 * @param argv - arguments after the script name.
 * @param defaultReportDir - where reports go when `--report` is absent.
 * @returns the process exit code.
 */
export function main(argv: readonly string[], defaultReportDir: string): number {
  const parsed = parseArgs(argv, defaultReportDir);
  if (!parsed.ok) {
    process.stderr.write(`${parsed.error}\n`);
    const harness = smokeHarnessFor(argv[0] ?? '');
    if (harness) process.stderr.write(`Arm it with: ${armLine(harness)}\n`);
    return 2;
  }
  return runSmoke(parsed.options).exitCode;
}

// Executed, not imported: `run.sh` is the only caller, and the tests drive
// `main`/`runSmoke` directly so that nothing here fires while they are loaded.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
  process.exitCode = main(process.argv.slice(2), join(repoRoot, 'test-results', 'harness-smoke'));
}
