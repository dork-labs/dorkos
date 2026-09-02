/**
 * The Claude CLI auth probe: the ONE place that answers "does the `claude`
 * binary on this machine resolve, and is it signed in?".
 *
 * Two callers need that answer and must never disagree about it:
 *
 * 1. the onboarding readiness ladder (`check-dependency.ts`), which projects a
 *    signed-out Claude to the Connect surface (DOR-438);
 * 2. the eval harness (`@dorkos/evals`), which decides whether a credentialed
 *    eval can boot at all. Its child-process launcher inherits `PATH` and `HOME`,
 *    so whatever this probe reports about the host is exactly what the launched
 *    server will find.
 *
 * A second, private copy of this probe in the harness would drift from the
 * readiness ladder the first time either side learned something new about the
 * CLI, and the two surfaces would then tell a developer different things about
 * the same sign-in. Hence one module, imported by both.
 *
 * Read-only and ToS-safe: this spawns the CLI's own `auth status --json`
 * subcommand and reads the boolean `loggedIn` flag. It never reads token
 * material, never touches the keychain directly, and never starts a login flow.
 *
 * @module services/runtimes/claude-code/tooling/claude-cli-auth
 */
import { resolveClaudeBinaryBeforePath } from '../sdk/sdk-utils.js';
import { findBinaryOnPath, logProbeFailure, runBinaryProbe } from '../../shared/run-probe.js';

/** Hard bound on each Claude CLI probe (the PATH locate, `--version`, and `auth status`). */
export const CLAUDE_PROBE_TIMEOUT_MS = 5_000;

/** Auth-check name, as the requirements payload and the log both spell it. */
const AUTH_PROBE_LABEL = 'Claude Code authentication';

/**
 * Resolve the `claude` executable to probe: the `DORKOS_CLAUDE_CLI_PATH`
 * override, then the SDK's bundled native binary, then a provisioned install,
 * then `PATH`.
 *
 * This is the SAME ladder the SDK spawn seam walks — literally the same rungs
 * ({@link resolveClaudeBinaryBeforePath}), differing only in the final `PATH`
 * lookup, which is the bounded ASYNC one here so a stalled `PATH` mount can
 * never block the event loop. When the two walked DIFFERENT rungs, the packaged
 * Mac app ran sessions on a binary this probe called missing (DOR-1334 / F2).
 *
 * One ladder is not the same as one answer at one moment: this probe re-walks it
 * on every poll, while a live `ClaudeCodeRuntime` keeps the binary it resolved
 * and only re-checks while it has none (see its `spawnBinaryPath`). So a `claude`
 * that appears on `PATH` mid-run can read `satisfied` here before a running
 * runtime picks it up; a provisioned one is picked up immediately.
 *
 * @returns Absolute path to the binary, or `null` when unresolvable.
 */
export async function resolveClaudeBinaryPath(): Promise<string | null> {
  return (
    resolveClaudeBinaryBeforePath() ?? (await findBinaryOnPath('claude', CLAUDE_PROBE_TIMEOUT_MS))
  );
}

/** What `claude auth status --json` reports about this machine's sign-in (never any token material). */
export interface ClaudeAuthStatus {
  /** Whether the CLI reports an authenticated session. */
  loggedIn: boolean;
  /**
   * How the CLI is authenticated, verbatim from the CLI. Measured against claude
   * 2.1.224: `claude.ai` (a stored subscription sign-in EXISTS in this config
   * dir), `api_key` (an `ANTHROPIC_API_KEY` and NO stored sign-in),
   * `oauth_token` (an inherited `CLAUDE_CODE_OAUTH_TOKEN`), `none` (signed out).
   * Absent when the CLI does not report one.
   *
   * Read this as "what is stored", not "what will be used" — with both a stored
   * sign-in and an env key present it still reports `claude.ai`, so it cannot on
   * its own tell you whether the stored sign-in's deadline matters. Pair it with
   * {@link ClaudeAuthStatus.apiKeySource}.
   */
  authMethod?: string;
  /**
   * The env var supplying an API key (e.g. `ANTHROPIC_API_KEY`), when one is in
   * play. Absent for a pure subscription sign-in and for an inherited
   * `CLAUDE_CODE_OAUTH_TOKEN`.
   *
   * This is what distinguishes "the stored sign-in is what serves turns" from
   * "there is also a key here, so a lapsed stored sign-in is not a problem".
   */
  apiKeySource?: string;
}

/** Parse `claude auth status --json` output (reads two non-secret fields; no token material). */
function parseAuthStatus(statusJson: string): ClaudeAuthStatus | null {
  try {
    const parsed: unknown = JSON.parse(statusJson);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { loggedIn, authMethod, apiKeySource } = parsed as {
      loggedIn?: unknown;
      authMethod?: unknown;
      apiKeySource?: unknown;
    };
    return {
      loggedIn: loggedIn === true,
      ...(typeof authMethod === 'string' ? { authMethod } : {}),
      ...(typeof apiKeySource === 'string' ? { apiKeySource } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * Ask the CLI whether it is authenticated by ANY means a spawned subprocess
 * would also honor: the host's own `claude` sign-in (read platform-appropriately
 * from the macOS Keychain service "Claude Code-credentials", or
 * `~/.claude/.credentials.json` on Linux/WSL), an inherited `ANTHROPIC_API_KEY`,
 * or an inherited `CLAUDE_CODE_OAUTH_TOKEN`. `claude auth status --json` prints
 * `{"loggedIn":true,...}` and exits 0 when authenticated, and exits non-zero
 * (which `runBinaryProbe` rejects) when signed out. Asking the CLI instead of
 * hand-reading the keychain keeps this cross-platform and always in step with
 * whatever the CLI actually honors.
 *
 * A PRESENT-but-expired or revoked credential still reads `true`: `auth status`
 * reports from stored state without a live network check, so nothing THIS probe
 * asks can tell an expired token from a valid one. Two other things cover that
 * gap: `claude-sign-in-expiry.ts` reads the stored sign-in's own renewal
 * deadline, which catches a subscription sign-in that has run out of time; and
 * in-session auth-error remediation catches a revoked credential when a turn
 * actually fails. `authMethod` is reported here because that expiry read applies
 * to exactly one of these credentials and must not be attributed to the others.
 *
 * @param binary - The resolved `claude` binary (or `null` when none resolved).
 * @param env - Full environment for the probe, which decides WHICH account it
 *   reports on. Omit to inherit this process's, which is what the eval harness
 *   wants ("can a subprocess I spawn reach a model?"); the readiness ladder
 *   passes a pinned one so its answer describes the account sessions launch on.
 * @returns The reported status, or `null` when the CLI could not be asked at all
 *   (no binary, signed out — which exits non-zero — or a bounded-out probe).
 */
export async function readClaudeAuthStatus(
  binary: string | null,
  env?: NodeJS.ProcessEnv
): Promise<ClaudeAuthStatus | null> {
  if (!binary) return null;
  try {
    const out = await runBinaryProbe(
      binary,
      ['auth', 'status', '--json'],
      CLAUDE_PROBE_TIMEOUT_MS,
      env
    );
    return parseAuthStatus(out);
  } catch (err) {
    // Non-zero exit (signed out) or a bounded-out probe. Reported once per
    // distinct failure so "authentication: missing" is never unexplainable.
    logProbeFailure(AUTH_PROBE_LABEL, binary, err);
    return null;
  }
}

/**
 * Whether the CLI reports an authenticated session — the boolean the eval
 * harness asks for, and the same answer {@link readClaudeAuthStatus} gives.
 *
 * @param binary - The resolved `claude` binary (or `null` when none resolved).
 * @returns True when the CLI reports an authenticated session.
 */
export async function isClaudeCliAuthenticated(binary: string | null): Promise<boolean> {
  return (await readClaudeAuthStatus(binary))?.loggedIn === true;
}

/**
 * Resolve the `claude` binary and ask whether it is signed in, in one call — the
 * shape the eval harness wants ("can a subprocess I spawn reach a model through
 * the local CLI?").
 *
 * @returns True when a `claude` binary resolved AND reports an authenticated session.
 */
export async function hasLocalClaudeLogin(): Promise<boolean> {
  return isClaudeCliAuthenticated(await resolveClaudeBinaryPath());
}
