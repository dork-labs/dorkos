/**
 * The money gate on the real-harness smoke — the fourth path in this repo that
 * can spend real money, and it has the same shape as the other three.
 *
 * `AGENTS.md`'s rule, restated because this file is where it is enforced: **the
 * flag is the decision, the key is the instrument, and a key alone arms
 * nothing.** Plenty of people leave `ANTHROPIC_API_KEY` or `OPENAI_API_KEY`
 * exported because half a toolchain wants one; having a key is not the same as
 * deciding to spend. So a run needs two independent deliberate acts, and each of
 * the four squares of that truth table behaves.
 *
 * Two things this gate deliberately does NOT do, both of them the reason it
 * exists rather than a `!!process.env.X` in the runner:
 *
 * 1. **It never consults an ambient sign-in.** Not `~/.claude`, not the macOS
 *    keychain, not `~/.codex/auth.json`, not `claude auth status`. Those are how
 *    every agent on this machine reaches a model every day, which is exactly why
 *    a smoke may not use one: a run that silently billed the operator's own
 *    subscription would be spending money nobody armed. The evals runner's
 *    comment says it in one line — "a fake key is not a safe way to run the
 *    Anthropic one: the test server inherits your `claude` sign-in and bills that
 *    instead". The instrument is a VALUE somebody exported on purpose, or there
 *    is no instrument.
 * 2. **It reads exactly one pinned variable name per harness.** There is no
 *    "which secret?" input and there must never be one; `packages/evals`'s
 *    `credentials.ts` records what a caller-named secret bought (a dispatcher
 *    could point a run at any secret in the repo and have it shipped as an auth
 *    header). A new harness gets a new pinned name here, in
 *    {@link ../harnesses.js | the descriptor table}.
 *
 * The flag is read ONCE, at module scope, for the reason
 * `packages/evals/src/runner/credentials.ts` gives for its own: a lazily-read
 * flag is something a helper could flip on the way to a turn, and a `vi.stubEnv`
 * in some other file cannot blank a module-scope read. Every test here drives
 * the injected `optIn` seam instead of the real variable, so the four squares are
 * exercised without ever setting one.
 *
 * @module harness-smoke/gate
 */
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { HARNESS_SMOKE_OPT_IN_VAR, type SmokeHarness } from './harnesses.js';

/**
 * Whether somebody DECIDED to spend on a real harness in this process.
 *
 * Read once, at module scope; see the module docstring for why that is the whole
 * defense rather than a style preference.
 */
// eslint-disable-next-line no-restricted-syntax -- the opt-in flag IS the spend gate; reading it here (once, at module scope) is what makes it un-stubbable.
const HARNESS_SMOKE_OPT_IN = process.env[HARNESS_SMOKE_OPT_IN_VAR] === '1';

/** Why a smoke run may not proceed, or the instrument that lets it. */
export type SmokeGate =
  /** Both deliberate acts are present and the binary is there; here is what to run with. */
  | { ok: true; key: string; binaryPath: string }
  /**
   * Nobody asked to spend. Not a failure — the run writes a SKIP report and
   * exits 0, because a smoke that is not armed has not found anything wrong.
   */
  | { ok: false; reason: 'no-opt-in'; message: string }
  /** Somebody asked to spend and named no instrument for this harness. */
  | { ok: false; reason: 'no-key'; message: string }
  /** Both acts are present and the harness is not installed on this machine. */
  | { ok: false; reason: 'no-binary'; message: string };

/** Injectable seams so every square of the truth table is reachable without a real key. */
export interface ResolveSmokeGateDeps {
  /** Environment to read the harness's ONE pinned variable from. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /**
   * Whether the deliberate-act flag is set. Defaults to the module-scope read,
   * which is the real gate.
   */
  optIn?: boolean;
  /**
   * Resolve the harness binary to an absolute path, or `undefined` when it is
   * not installed. Defaults to a `PATH` lookup.
   */
  findBinary?: (binary: string) => string | undefined;
  /**
   * An explicit binary path from `--binary`, for a harness that is installed
   * somewhere `PATH` does not name (DorkOS provisions OpenCode under its own
   * data directory). Checked for existence by `findBinary`'s caller, not here.
   */
  binaryOverride?: string;
}

/** Read a pinned variable, treating an empty or whitespace-only value as unset. */
function readVar(env: Record<string, string | undefined>, name: string): string | undefined {
  const raw = env[name];
  return raw && raw.trim() !== '' ? raw : undefined;
}

/**
 * Decide whether this run may drive a real harness, and with what.
 *
 * The ORDER of the three checks is the policy, not an implementation detail:
 * the flag is asked for first, so a machine that merely has a key exported never
 * reaches the question of whether the key is good; the key is asked for second,
 * so an unarmed machine with the binary installed still reports the honest
 * reason; the binary is asked for last, because "you are not set up to run this"
 * is the least interesting of the three answers.
 *
 * @param harness - the harness descriptor, which owns the pinned variable name.
 * @param deps - injectable env, opt-in and binary-lookup seams; all default to the real ones.
 * @returns the instrument and binary, or the refusal and why.
 */
export function resolveSmokeGate(
  harness: SmokeHarness,
  deps: ResolveSmokeGateDeps = {}
): SmokeGate {
  const optIn = deps.optIn ?? HARNESS_SMOKE_OPT_IN;
  if (!optIn) return { ok: false, reason: 'no-opt-in', message: optInMessage(harness) };

  const env =
    deps.env ??
    // eslint-disable-next-line no-restricted-syntax -- the smoke's instrument is a runner secret read once here (the harness env carve-out pattern), never an app config value.
    process.env;
  const key = readVar(env, harness.keyVar);
  if (!key) return { ok: false, reason: 'no-key', message: noKeyMessage(harness) };

  const binaryPath = resolveBinary(harness, deps);
  if (!binaryPath) {
    return {
      ok: false,
      reason: 'no-binary',
      message: noBinaryMessage(harness, deps.binaryOverride),
    };
  }

  return { ok: true, key, binaryPath };
}

/**
 * Resolve the binary, checking an EXPLICIT `--binary` for existence too.
 *
 * Taking the override on trust was a hole with a bad failure mode rather than an
 * obvious one: `spawnSync` on a path that is not there answers with
 * `status: null` and an `ENOENT` in `error`, which the runner then reported as
 * "the turn never exited on its own; it was killed after 300s" — a typo in a
 * path dressed up as a hung harness.
 *
 * @param harness - the harness being asked for.
 * @param deps - the injectable seams.
 * @returns an executable absolute path, or `undefined`.
 */
function resolveBinary(harness: SmokeHarness, deps: ResolveSmokeGateDeps): string | undefined {
  const find = deps.findBinary ?? findOnPath;
  if (deps.binaryOverride === undefined) return find(harness.binary);
  return isExecutable(deps.binaryOverride) ? deps.binaryOverride : undefined;
}

/** Whether a path names something this process may execute. */
function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether this run may drive the harness for FREE.
 *
 * `--free` reaches no model, so it needs neither the flag nor a key — there is
 * nothing to arm and nothing to spend. What it does still need is every other
 * property of the paid path: the binary, and the isolation. A free run gets the
 * same empty `HOME` and empty config home as a paid one, so it can no more read
 * a stored sign-in than a paid one can. That is not a nicety: a probe that
 * inherited the operator's home would answer with the operator's skills and
 * report the fixture's tree as containing them.
 *
 * @param harness - the harness to probe.
 * @param deps - injectable binary-lookup seams.
 * @returns the binary to run, or the refusal and why.
 */
export function resolveFreeGate(
  harness: SmokeHarness,
  deps: ResolveSmokeGateDeps = {}
):
  | { ok: true; binaryPath: string }
  | { ok: false; reason: 'no-free-probe' | 'no-binary'; message: string } {
  if (harness.free.kind === 'none') {
    return {
      ok: false,
      reason: 'no-free-probe',
      message:
        `There is no free probe for ${harness.label}. ${harness.free.note}\n` +
        `Run it with an instrument instead: ${HARNESS_SMOKE_OPT_IN_VAR}=1 ${harness.keyVar}=<key>.`,
    };
  }
  const binaryPath = resolveBinary(harness, deps);
  if (!binaryPath) {
    return {
      ok: false,
      reason: 'no-binary',
      message: noBinaryMessage(harness, deps.binaryOverride),
    };
  }
  return { ok: true, binaryPath };
}

/**
 * Look a binary up on `PATH`, the way a shell would.
 *
 * Deliberately not `which`/`command -v` through a subprocess: this runs before
 * the gate has decided anything, and a smoke that shells out to answer "is the
 * harness installed" has already done more than a refused run should.
 *
 * @param binary - the executable's name.
 * @returns its absolute path, or `undefined` when `PATH` does not name it.
 */
export function findOnPath(binary: string): string | undefined {
  // eslint-disable-next-line no-restricted-syntax -- PATH is the shell's own interface for finding a program; there is no app config equivalent.
  const path = process.env.PATH ?? '';
  for (const dir of path.split(delimiter)) {
    if (dir === '') continue;
    const candidate = join(dir, binary);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not here, or not executable. Keep looking.
    }
  }
  return undefined;
}

/**
 * The message an unarmed run gets. Says plainly that the run spends real money
 * and names BOTH variables, so the person reading it can decide rather than
 * guess.
 *
 * @param harness - the harness that was asked for.
 * @returns the refusal message.
 */
export function optInMessage(harness: SmokeHarness): string {
  return (
    `This run would drive a real ${harness.label} and spend real money, so it needs you to say ` +
    `so: set ${HARNESS_SMOKE_OPT_IN_VAR}=1 alongside ${harness.keyVar}.\n` +
    `A key on its own is deliberately not enough — plenty of people leave one exported, and ` +
    `having a key is not the same as deciding to spend.\n` +
    `Nothing ran, nothing was billed, and no sign-in on this machine was read.`
  );
}

/**
 * The message an armed run with no instrument gets. Names the one variable this
 * harness reads and says why the sign-in sitting on the machine is not it.
 *
 * @param harness - the harness that was asked for.
 * @returns the refusal message.
 */
export function noKeyMessage(harness: SmokeHarness): string {
  return (
    `This run was armed with ${HARNESS_SMOKE_OPT_IN_VAR}=1, but ${harness.keyVar} is not set, ` +
    `so there is nothing to reach a model with. ${harness.credentialContract}\n` +
    `A sign-in already stored on this machine is deliberately NOT used: it would bill your own ` +
    `subscription for a run nobody armed, and the smoke could not tell you which credential paid.`
  );
}

/**
 * The message a run gets when the harness is not installed. A skip, not a
 * failure — the smoke has found nothing wrong with the projection.
 *
 * @param harness - the harness that was asked for.
 * @returns the skip message.
 */
export function noBinaryMessage(harness: SmokeHarness, override?: string): string {
  if (override !== undefined) {
    return (
      `\`--binary ${override}\` is not an executable file, so there is no ${harness.label} to ask.\n` +
      `Checked before anything was launched on purpose: a bad path handed to \`spawn\` comes back ` +
      `as a killed process with no exit code, which reads as a hung harness rather than a typo.`
    );
  }
  return (
    `\`${harness.binary}\` is not on PATH, so there is no ${harness.label} to ask. ${harness.installHint}\n` +
    `Pass \`--binary <path>\` when it is installed somewhere PATH does not name.`
  );
}
