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
import { resolveFreeGate, resolveSmokeGate } from './gate.js';
import {
  INSTRUCTIONS_SENTINEL,
  SMOKE_SCENARIOS,
  stageSmokeFixture,
  type SmokeFixture,
  type SmokeScenario,
} from './fixture.js';
import {
  SMOKE_HARNESS_IDS,
  smokeHarnessFor,
  type ListingObservation,
  type ProbeCommand,
  type SmokeHarness,
  type TurnObservation,
} from './harnesses.js';
import { calibrationVerdict } from './calibration.js';
import {
  activationVerdicts,
  ceilingVerdict,
  credentialVerdict,
  listingVerdicts,
  overallStatus,
  sentinelVerdict,
  type ListingAbsence,
  type Verdict,
} from './oracles.js';
import { userTierNotRun, userTierVerdicts } from './user-tier.js';
import {
  armLine,
  renderRunReport,
  renderSkipReport,
  renderUserTierReport,
  reportFileName,
  type UserTierRoundReport,
} from './report.js';

/**
 * The default ceiling, in USD.
 *
 * A tripwire for a runaway loop, not an allowance: one turn against the fixture
 * costs fractions of a cent, so reaching this means something looped. The same
 * number the evals runner's paid tier uses, for the same reason.
 */
export const DEFAULT_MAX_USD = 0.5;

/**
 * What a `--free` run puts in the instrument's slot.
 *
 * A free run has no instrument by construction, and the harness still wants the
 * variable set — Claude Code reports `apiKeySource` off it, which is how the
 * free run answers the credential oracle at all. It is never a credential: the
 * base URL beside it points at a port nothing is listening on, so the value
 * cannot reach anything. Spelled so it is unmistakable in a process listing.
 */
export const FREE_PLACEHOLDER_KEY = 'dorkos-harness-smoke-free-mode-not-a-key';

/** How long a single probe may take before the run gives up on it. */
const PROBE_TIMEOUT_MS = 300_000;

/**
 * How long a FREE probe may take.
 *
 * Much shorter, because a free Claude Code turn is never going to finish: it is
 * pointed at a base URL nothing is listening on, and everything the run needs —
 * both `SessionStart` hooks and the `system`/`init` message — is printed within
 * a couple of seconds, before the first API request. The rest is the CLI
 * retrying a dead endpoint, and waiting five minutes for that is five minutes of
 * nothing.
 */
const FREE_PROBE_TIMEOUT_MS = 45_000;

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
  /** An explicit model id, overriding the harness's pinned cheap one. */
  model?: string;
  /** Run only the oracles that reach no model, and spend nothing. */
  free: boolean;
  /** Which fixture to ask about. `project` is the original and the default. */
  scenario: SmokeScenario;
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
      error:
        `Usage: run.sh <${SMOKE_HARNESS_IDS.join('|')}> ` +
        `[--free] [--scenario ${SMOKE_SCENARIOS.join('|')}] [--max-usd N] [--report DIR] ` +
        `[--binary PATH] [--model ID]`,
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
  let model: string | undefined;
  let free = false;
  let scenario: SmokeScenario = 'project';

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
    } else if (flag === '--model') {
      if (value === undefined || value.trim() === '') {
        return { ok: false, error: '--model needs a model id.' };
      }
      model = value;
      index += 1;
    } else if (flag === '--scenario') {
      if (value === undefined || !isScenario(value)) {
        return {
          ok: false,
          error: `--scenario needs one of ${SMOKE_SCENARIOS.join(', ')}, got \`${value ?? ''}\`.`,
        };
      }
      scenario = value;
      index += 1;
    } else if (flag === '--free') {
      free = true;
    } else {
      return { ok: false, error: `Unknown flag \`${flag ?? ''}\`.` };
    }
  }

  return {
    ok: true,
    options: {
      harness,
      maxUsd,
      reportDir,
      free,
      scenario,
      ...(binary ? { binary } : {}),
      ...(model ? { model } : {}),
    },
  };
}

/** Whether a word names a fixture scenario. */
function isScenario(word: string): word is SmokeScenario {
  return (SMOKE_SCENARIOS as readonly string[]).includes(word);
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
 * A FREE run gets the SAME isolation. It reaches no model, so it needs no real
 * key — but a probe that inherited the operator's home would answer with the
 * operator's `~/.agents/skills` and `~/.claude/skills` and report the fixture's
 * tree as containing them, which is a wrong answer rather than a cheap one.
 *
 * @param harness - the harness being launched.
 * @param key - the instrument the gate resolved, or the free run's placeholder.
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

/** What one probe did. */
interface ProbeResult {
  /** Everything it printed on stdout. */
  stdout: string;
  /** Everything it printed on stderr. */
  stderr: string;
  /** Its exit code, or `null` when it was killed or never started. */
  status: number | null;
  /**
   * What went wrong at the process level, when something did.
   *
   * `spawnSync` reports a missing binary and a timeout kill the same way through
   * `status: null`, so without this the runner said "the turn never exited on
   * its own; it was killed after 300s" about a path with a typo in it. The
   * `code` is what separates them, and the difference is load-bearing rather
   * than cosmetic: `ETIMEDOUT` means the process RAN and was stopped — which is
   * the design of a `--free` turn, whose hooks and session-init message arrive
   * long before the kill — while `ENOENT` means nothing ever started and every
   * oracle downstream is meaningless.
   */
  error?: { message: string; code?: string };
}

/** Run one probe in the fixture and hand back what it printed. */
function runProbe(
  probe: ProbeCommand,
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number
): ProbeResult {
  const result = spawnSync(probe.command, probe.args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: timeoutMs,
    // Close stdin immediately. `claude --print` waits three seconds for piped
    // input before giving up on it, and an open pipe nobody writes to is three
    // seconds of nothing on every run.
    input: '',
    // Nothing here goes through a shell: every argument is passed as an
    // argument, so a fixture path with a space in it cannot become two words and
    // a prompt cannot become a command.
    shell: false,
  });
  return {
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    status: result.status,
    ...(result.error
      ? {
          error: {
            message: result.error.message,
            ...((result.error as NodeJS.ErrnoException).code === undefined
              ? {}
              : { code: (result.error as NodeJS.ErrnoException).code as string }),
          },
        }
      : {}),
  };
}

/**
 * Whether a probe's process actually started.
 *
 * A timeout kill is a process that RAN and was stopped; a spawn failure is one
 * that never started. Only the second invalidates the oracles behind it, and the
 * difference is load-bearing rather than pedantic: a `--free` Claude Code turn
 * is ALWAYS killed by the timeout — that is its design — and its hooks and its
 * session-init message arrive long before the kill. Treating that kill as "never
 * ran" reported every free run's hook verdicts as NOT RUN when the hooks had
 * demonstrably fired.
 *
 * @param result - what the probe did.
 * @returns true when a process existed to observe.
 */
export function processStarted(result: { error?: { message: string; code?: string } }): boolean {
  return result.error === undefined || result.error.code === 'ETIMEDOUT';
}

/**
 * The prompt the one turn is given.
 *
 * Per scenario, because the two scenarios ask different things and a prompt is
 * printed in the report: the project fixture's turn drives the skill-activation
 * oracle and the sentinel, and the user tier has neither — a turn there exists
 * only so that Claude Code prints the session-init message that carries the
 * listing, and naming a probe skill that was never staged would put a sentence
 * in the report that is not true of the run.
 *
 * @param scenario - which fixture the turn is being asked about.
 * @returns the prompt.
 */
function turnPrompt(scenario: SmokeScenario): string {
  if (scenario === 'user-tier') {
    return 'List the skills you have loaded, and nothing else.';
  }
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
  const reportPath = join(
    options.reportDir,
    reportFileName(startedAt, harness.id, options.scenario)
  );
  const binaryOverride = options.binary === undefined ? {} : { binaryOverride: options.binary };

  // A free run needs no flag and no key — it reaches no model — but it needs the
  // binary and it gets the SAME isolation. See `resolveFreeGate`.
  const gate = options.free
    ? resolveFreeGate(harness, binaryOverride)
    : resolveSmokeGate(harness, binaryOverride);
  if (!gate.ok) {
    writeFileSync(reportPath, renderSkipReport(harness, startedAt, gate.reason, gate.message));
    process.stdout.write(`SKIPPED (${gate.reason})\n\n${gate.message}\n\n`);
    process.stdout.write(`Cost: nothing — no model was reached.\n`);
    process.stdout.write(`Report: ${reportPath}\n`);
    // A skip is not a failure. The gate refusing is the gate working.
    return { exitCode: 0, reportPath };
  }

  if (options.scenario === 'user-tier') {
    return runUserTierSmoke(harness, gate, options, startedAt, reportPath);
  }

  const fixture = stageSmokeFixture(harness);
  try {
    const observed = probeHarness(harness, fixture, gate, options);
    const calibration = calibrationVerdict(harness, fixture.repoRoot, observed.listing);
    const verdicts: Verdict[] = [
      ...listingVerdicts(harness, observed.listing, fixture.repoRoot, observed.absence),
      ...activationVerdicts(
        harness,
        fixture.authoredHookNonce,
        fixture.pluginHookNonce,
        fixture.skillNonce,
        { turnRan: observed.turnRan, skillProbeRan: observed.skillProbeRan }
      ),
      // The sentinel keys on whether a MODEL answered, not on whether a session
      // started: a free Claude Code run starts a session, prints its listing and
      // fires its hooks, and never produces an answer to look in.
      sentinelVerdict(
        harness,
        observed.turn.text,
        INSTRUCTIONS_SENTINEL,
        observed.turnRan && observed.skillProbeRan
      ),
      credentialVerdict(harness, observed.turn, options.free),
      ...(options.free ? [] : [ceilingVerdict(harness, observed.turn, options.maxUsd)]),
      calibration.verdict,
    ];

    const report = renderRunReport({
      harness,
      startedAt,
      maxUsd: options.maxUsd,
      free: options.free,
      pinnedModel: modelFor(harness, options),
      verdicts,
      calibration: calibration.findings,
      applied: fixture.applied,
      notRun: observed.notRun,
      ...(observed.turn.model === undefined ? {} : { reportedModel: observed.turn.model }),
      ...(observed.turn.costUsd === undefined ? {} : { costUsd: observed.turn.costUsd }),
      ...(observed.turnCommand === undefined ? {} : { turnCommand: observed.turnCommand }),
    });
    writeFileSync(reportPath, report);

    for (const verdict of verdicts) {
      process.stdout.write(`${verdict.status.toUpperCase().padEnd(8)}${verdict.id}\n`);
    }
    process.stdout.write(
      `\nCost: ${
        options.free
          ? 'nothing — --free reaches no model'
          : observed.turn.costUsd === undefined
            ? `not reported by ${harness.label}`
            : `${observed.turn.costUsd.toFixed(4)} USD (ceiling ${options.maxUsd} USD)`
      }\n`
    );
    process.stdout.write(`Report: ${reportPath}\n`);
    for (const note of observed.notes) process.stdout.write(`${note}\n`);
    return { exitCode: overallStatus(verdicts) === 'failed' ? 1 : 0, reportPath };
  } finally {
    fixture.cleanup();
  }
}

/**
 * Run the user-tier scenario: one staging and one probe PER ROUND, and one
 * report holding all of them.
 *
 * A round is a whole fixture, not a flag, and that is the point. Both rounds ask
 * which directory in a person's home the harness opens, and a single staging
 * that wrote both could not tell "this harness does not read `~/.agents/skills`"
 * apart from "it stops reading it once its own skills folder exists". A second
 * free turn costs 45 seconds of nothing.
 *
 * It shares the whole spine with the project scenario — the same gate, the same
 * curated environment, the same `spawnSync`, the same verdict vocabulary. What
 * differs is the fixture it stages and the question it asks, which is why this
 * is a branch rather than a second runner.
 *
 * @param harness - the harness being asked.
 * @param gate - the binary the gate resolved, and the instrument when there is one.
 * @param options - what the command line asked for.
 * @param startedAt - the run's start, ISO-8601.
 * @param reportPath - where the report goes.
 * @returns the process exit code, and the report it wrote.
 */
function runUserTierSmoke(
  harness: SmokeHarness,
  gate: { binaryPath: string; key?: string },
  options: SmokeOptions,
  startedAt: string,
  reportPath: string
): { exitCode: number; reportPath: string } {
  const rounds: UserTierRoundReport[] = [];
  const verdicts: Verdict[] = [];
  let credential: Verdict | undefined;

  for (const round of harness.userTierRounds) {
    const fixture = stageSmokeFixture(harness, { scenario: 'user-tier', round });
    try {
      const observed = probeHarness(harness, fixture, gate, options);
      const roundVerdicts = [
        ...userTierVerdicts(harness, fixture.subjects, observed.listing, observed.absence),
        // Only on the paid path, and per ROUND rather than per run: the ceiling
        // is a per-turn flag on the binary, so a run of two rounds bounded one
        // turn twice and the report has to say that rather than imply one
        // number covered both.
        ...(options.free ? [] : [ceilingVerdict(harness, observed.turn, options.maxUsd)]),
      ];
      verdicts.push(...roundVerdicts);
      // The same environment serves every round, so the credential answer is a
      // property of the RUN. Taken from the first round that produced one, and
      // reported once, rather than repeated under each heading as if it were
      // three separate measurements.
      credential ??=
        observed.turn.credentialSource === undefined
          ? undefined
          : credentialVerdict(harness, observed.turn, options.free);
      rounds.push({
        round,
        roots: fixture.userTierRoots,
        injectDirs: fixture.injectDirs,
        staged: fixture.applied,
        verdicts: roundVerdicts,
        ...(observed.listing ? { listing: observed.listing } : {}),
        ...(observed.turn.costUsd === undefined ? {} : { costUsd: observed.turn.costUsd }),
        // The turn's argv where the listing rides a turn, the listing probe's
        // where it does not. One of the two always exists, and a report that did
        // not carry it could not be re-run by the person reading it.
        ...((observed.turnCommand ?? observed.listingCommand) === undefined
          ? {}
          : { command: (observed.turnCommand ?? observed.listingCommand) as string }),
        notes: observed.notes,
      });
    } finally {
      fixture.cleanup();
    }
  }

  credential ??= credentialVerdict(harness, { startupSeen: false, text: '' }, options.free);
  verdicts.push(credential);

  writeFileSync(
    reportPath,
    renderUserTierReport({
      harness,
      startedAt,
      free: options.free,
      pinnedModel: modelFor(harness, options),
      rounds,
      credential,
      notRun: userTierNotRun(harness),
    })
  );

  for (const round of rounds) {
    process.stdout.write(`--- ${round.round}\n`);
    for (const verdict of round.verdicts) {
      process.stdout.write(`${verdict.status.toUpperCase().padEnd(8)}${verdict.id}\n`);
    }
  }
  process.stdout.write(`--- run\n`);
  process.stdout.write(`${credential.status.toUpperCase().padEnd(8)}${credential.id}\n`);
  const spent = rounds.reduce((total, round) => total + (round.costUsd ?? 0), 0);
  process.stdout.write(
    `\nCost: ${
      options.free
        ? 'nothing — --free reaches no model'
        : rounds.every((round) => round.costUsd === undefined)
          ? `not reported by ${harness.label}`
          : `${spent.toFixed(4)} USD across ${rounds.length} round(s)`
    }\n`
  );
  process.stdout.write(`Report: ${reportPath}\n`);
  for (const round of rounds) for (const note of round.notes) process.stdout.write(`${note}\n`);
  return { exitCode: overallStatus(verdicts) === 'failed' ? 1 : 0, reportPath };
}

/** The model this run pins: the harness's cheap one, or an explicit override. */
function modelFor(harness: SmokeHarness, options: SmokeOptions): string {
  return options.model ?? harness.model.id;
}

/** Everything the probes observed, and what they could not reach. */
interface ProbeOutcome {
  /** What the harness listed, if anything did. */
  listing?: ListingObservation;
  /** Why a listing is missing, when one is. */
  absence: ListingAbsence;
  /** What the turn said. */
  turn: TurnObservation;
  /** Whether ANY session was started — false when a free harness has no free turn. */
  turnRan: boolean;
  /** Whether a MODEL turn happened — false for every `--free` run. */
  skillProbeRan: boolean;
  /** The turn's command line, for reproduction. Absent when no turn ran. */
  turnCommand?: string;
  /**
   * The non-model listing probe's command line, for reproduction.
   *
   * Recorded for the same reason the turn's is: a report that says what a binary
   * answered without saying what it was asked cannot be re-run by the person
   * reading it. Absent for a harness whose listing rides the turn.
   */
  listingCommand?: string;
  /** Oracles this run deliberately did not reach, in the report's words. */
  notRun: string[];
  /** Lines to print after the report path. */
  notes: string[];
}

/**
 * Run whichever probes this mode can afford.
 *
 * The paid path runs the non-model listing probe where one exists and then one
 * model turn. The free path runs whatever reaches no model: the listing probe
 * for a `listing-only` harness, and for `turn-init` a real turn pointed at a
 * base URL nothing is listening on, which prints its hooks and its session-init
 * message and then never completes.
 */
function probeHarness(
  harness: SmokeHarness,
  fixture: SmokeFixture,
  gate: { binaryPath: string; key?: string },
  options: SmokeOptions
): ProbeOutcome {
  const free = options.free;
  // The free path has no instrument by construction, so it carries a value that
  // says so. It is never a credential: nothing it is handed to can reach a model,
  // because the base URL beside it is dead.
  const key = gate.key ?? FREE_PLACEHOLDER_KEY;
  const freeEnv = free && harness.free.kind === 'turn-init' ? harness.free.env : {};
  const env = probeEnv(harness, key, fixture.configHome, freeEnv);
  const context = {
    repoRoot: fixture.repoRoot,
    binaryPath: gate.binaryPath,
    prompt: turnPrompt(options.scenario),
    noncesDir: fixture.noncesDir,
    model: modelFor(harness, options),
    maxUsd: options.maxUsd,
    injectDirs: fixture.injectDirs,
  };
  const timeout = free ? FREE_PROBE_TIMEOUT_MS : PROBE_TIMEOUT_MS;
  const notRun: string[] = [];
  const notes: string[] = [];

  let listing: ListingObservation | undefined;
  let listingCommand: string | undefined;
  if (harness.listingProbe && harness.parseListing) {
    const probe = harness.listingProbe(context);
    listingCommand = [probe.command, ...probe.args].join(' ');
    const result = runProbe(probe, fixture.repoRoot, { ...env, ...probe.env }, timeout);
    if (!processStarted(result)) {
      notes.push(`Note: the listing probe never started — ${result.error?.message ?? ''}`);
    }
    listing = harness.parseListing(result.stdout);
  }

  // A free run only takes a turn where the turn itself is free.
  const runsTurn = !free || harness.free.kind === 'turn-init';
  if (!runsTurn) {
    notRun.push(
      'the two hook-activation oracles, the skill-activation oracle and the sentinel — every one ' +
        `of them needs a session, and this harness has no free turn (${harness.free.note})`
    );
    return {
      ...(listing ? { listing } : {}),
      ...(listingCommand === undefined ? {} : { listingCommand }),
      absence: 'no-surface',
      turn: { startupSeen: false, text: '' },
      turnRan: false,
      skillProbeRan: false,
      notRun,
      notes,
    };
  }

  const probe = harness.turnProbe(context);
  const result = runProbe(probe, fixture.repoRoot, { ...env, ...probe.env }, timeout);
  const turn = harness.parseTurn(result.stdout);
  listing ??= turn.listing;

  if (!processStarted(result)) {
    notes.push(`Note: the turn never started — ${result.error?.message ?? ''}`);
  } else if (free) {
    notRun.push(
      'the skill-activation oracle, the sentinel and the ceiling — all three need a model to ' +
        'ANSWER, and `--free` reaches none. The hooks and the listing do not: they happen before ' +
        'the first API request, which is what makes a free run worth taking.'
    );
    notes.push(
      'Note: the free turn was pointed at a base URL nothing is listening on and was stopped ' +
        `after ${FREE_PROBE_TIMEOUT_MS / 1000}s. That is the design: the hooks and the ` +
        'session-init message arrive first, and nothing was billed.'
    );
  } else if (result.status === null) {
    notes.push(
      `Note: the turn never exited on its own; it was killed after ${PROBE_TIMEOUT_MS / 1000}s. ` +
        `stderr:\n${result.stderr}`
    );
  } else if (result.status !== 0) {
    notes.push(`Note: the turn exited ${String(result.status)}. stderr:\n${result.stderr}`);
  }

  return {
    ...(listing ? { listing } : {}),
    ...(listingCommand === undefined ? {} : { listingCommand }),
    // A harness with an in-turn listing that printed no startup record had an
    // oracle that DID NOT RUN, which is a different thing from never having one.
    absence:
      harness.listing.kind === 'in-turn' && !turn.startupSeen ? 'no-startup-record' : 'no-surface',
    turn,
    turnRan: processStarted(result),
    skillProbeRan: !free,
    turnCommand: [probe.command, ...probe.args].join(' '),
    notRun,
    notes,
  };
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
