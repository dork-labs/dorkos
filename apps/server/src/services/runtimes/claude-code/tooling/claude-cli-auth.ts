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

/** Whether `claude auth status --json` output reports an authenticated session (no token material read). */
function isLoggedIn(statusJson: string): boolean {
  try {
    const parsed: unknown = JSON.parse(statusJson);
    return (parsed as { loggedIn?: unknown }).loggedIn === true;
  } catch {
    return false;
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
 * reports from stored state without a live network check, so nothing here can
 * tell an expired token from a valid one. In-session auth-error remediation is
 * what catches a revoked credential when a turn actually fails.
 *
 * @param binary - The resolved `claude` binary (or `null` when none resolved).
 * @returns True when the CLI reports an authenticated session.
 */
export async function isClaudeCliAuthenticated(binary: string | null): Promise<boolean> {
  if (!binary) return false;
  try {
    const out = await runBinaryProbe(binary, ['auth', 'status', '--json'], CLAUDE_PROBE_TIMEOUT_MS);
    return isLoggedIn(out);
  } catch (err) {
    // Non-zero exit (signed out) or a bounded-out probe. Reported once per
    // distinct failure so "authentication: missing" is never unexplainable.
    logProbeFailure(AUTH_PROBE_LABEL, binary, err);
    return false;
  }
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
