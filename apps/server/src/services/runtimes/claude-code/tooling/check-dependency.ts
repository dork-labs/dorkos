/**
 * Claude Code dependency checks — verifies the `claude` CLI binary AND that
 * Claude is authenticated, the two external requirements for running Claude
 * agent sessions.
 *
 * Before this check, Claude reported only its binary, so
 * `deriveRuntimeReadiness` (which defaults `authReady = true` when a runtime
 * declares no auth check) flipped an installed-but-signed-out CLI straight to
 * "ready" — the first-run gate said "Claude Code is connected" for a CLI that
 * could not reach Claude, and the delegated sign-in flow was unreachable. This
 * adds a second `DependencyCheck` named to match the derivation's `/auth|login/i`
 * contract, so a signed-out Claude projects to Connect (`kind: 'login'`).
 *
 * Auth is satisfied by any rung of a read-only ladder (sibling of the OpenCode
 * change, ADR 260722-185415 — "whatever DorkOS's connect surface writes, DorkOS's
 * readiness surface must read"):
 *
 * 1. A DorkOS-stored Anthropic credential (`config.providers.anthropic`) that
 *    resolves through the same credential seam the message-sender injects at
 *    spawn. Checked first and separately because that secret is encrypted at
 *    rest and only materialized into `ANTHROPIC_API_KEY` at the SDK spawn seam —
 *    a separate `claude auth status` probe process never inherits it.
 * 2/3. The host's own Claude login OR an inherited env credential, both read via
 *    the CLI's own `claude auth status` — the codex-parity, read-only, ToS-safe
 *    probe, which lives in `claude-cli-auth.ts` because the eval harness asks the
 *    same question and the two answers must never drift apart.
 *
 * Probes are async and time-bounded (shared `run-probe` helpers): a hung binary
 * or a stalled `PATH` mount degrades to `missing` fast instead of blocking the
 * event loop, matching the Codex and OpenCode adapters.
 *
 * "Signed in" is not the same as "will work". `claude auth status` answers from
 * stored state, so a subscription sign-in that ran out of time still reads
 * `loggedIn: true` and this check said `satisfied` right up until a real turn
 * failed (DOR-1653). So a sign-in reported as working is then asked HOW LONG it
 * has left, via `claude-sign-in-expiry.ts`: the deadline rides along on the check
 * so the client can warn before anything breaks, and a sign-in already past the
 * point of renewal is demoted to `missing` so it takes the ordinary Connect path
 * instead of showing Ready. An unreadable deadline changes nothing.
 *
 * @module services/runtimes/claude-code/tooling/check-dependency
 */
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import type { UserConfig } from '@dorkos/shared/config-schema';
import { logProbeFailure, runBinaryProbe } from '../../shared/run-probe.js';
import { configManager } from '../../../core/config-manager.js';
import { credentialProvider, type CredentialProvider } from '../../../core/credential-provider.js';
import { ANTHROPIC_PROVIDER_ID } from '../../../core/credential-env.js';
import {
  CLAUDE_PROBE_TIMEOUT_MS,
  readClaudeAuthStatus,
  resolveClaudeBinaryPath,
  type ClaudeAuthStatus,
} from './claude-cli-auth.js';
import {
  isSignInUnusable,
  readClaudeSignInDeadlines,
  toIsoDeadline,
} from './claude-sign-in-expiry.js';

/** Hard bound on each Claude CLI probe (the PATH locate, `--version`, and `auth status`). */
const PROBE_TIMEOUT_MS = CLAUDE_PROBE_TIMEOUT_MS;

/** Binary-check name — the CLI probe the derivation matches with `/\bCLI\b/i`. */
const CLI_CHECK_NAME = 'Claude Code CLI';

/**
 * Auth-check name. MUST keep matching `deriveRuntimeReadiness`'s `/auth|login/i`
 * contract (`packages/shared/agent-runtime.ts`) so the runtime's Ready/Connect
 * projection keeps identifying this as the auth check (and maps a signed-out
 * Claude to `connect.kind: 'login'`).
 */
const AUTH_CHECK_NAME = 'Claude Code authentication';

/** Sign-in command shown in the Advanced disclosure — the CLI's own login (mirrors Codex's `codex login`). */
const CLAUDE_LOGIN_HINT = 'claude auth login';

/** Info URL for both checks. */
const CLAUDE_INFO_URL = 'https://docs.anthropic.com/en/docs/claude-code';

/** Return the platform-appropriate install command for the Claude Code CLI. */
function getInstallHint(): string {
  if (process.platform === 'win32') {
    return 'irm https://claude.ai/install.ps1 | iex';
  }
  // macOS, Linux, WSL
  return 'curl -fsSL https://claude.ai/install.sh | bash';
}

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/** Injectable seams for the credential-aware auth check (production defaults resolve the singletons). */
export interface ClaudeDependencyDeps {
  /** Config reader (defaults to the module singleton). */
  config?: ConfigReader;
  /** Credential read port used to resolve a stored Anthropic reference (defaults to the singleton). */
  credentialProvider?: CredentialProvider;
}

/** Check that a usable Claude Code binary resolves and answers `--version`. */
async function checkCliBinary(binary: string | null): Promise<DependencyCheck> {
  const name = CLI_CHECK_NAME;
  const description = 'The Claude Code CLI powers agent sessions in DorkOS.';

  if (binary) {
    try {
      const version = await runBinaryProbe(binary, ['--version'], PROBE_TIMEOUT_MS);
      return { name, description, status: 'satisfied', version };
    } catch (err) {
      // Binary resolved but failed to launch (or the probe timed out) — fall
      // through to "missing", but say so in the log: a resolvable binary that
      // will not run is exactly the case a person cannot diagnose from the
      // requirements payload alone (DOR-1334 / F3).
      logProbeFailure(name, binary, err);
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: getInstallHint(),
    infoUrl: CLAUDE_INFO_URL,
  };
}

/**
 * Rung 1 — a DorkOS-stored Anthropic credential (`config.providers.anthropic`)
 * that resolves through the same credential seam the message-sender injects into
 * the SDK subprocess (`resolveClaudeCredentialEnv`).
 *
 * Returns:
 * - a `satisfied` check when the reference resolves;
 * - `null` when no reference is set OR it no longer resolves, so the caller falls
 *   through to the host-login probe.
 *
 * A dangling reference deliberately falls through (unlike OpenCode, where a
 * dangling selected provider reports `missing`): the message-sender treats a
 * dangling Claude reference as "no key" and lets the SDK fall back to the host
 * login, so a broken stored key must NOT mask a working host sign-in — that would
 * be a false negative. If neither the reference nor the host login holds, the
 * host-login probe reports `missing` honestly.
 *
 * @param deps - Injectable config + credential-provider seams.
 */
async function checkPersistedCredential(
  deps: ClaudeDependencyDeps
): Promise<DependencyCheck | null> {
  const config = deps.config ?? configManager;
  const provider = deps.credentialProvider ?? credentialProvider;

  let ref: string | undefined;
  try {
    ref = config.get('providers')[ANTHROPIC_PROVIDER_ID];
  } catch {
    // Config unavailable — nothing stored to read; fall through to the host probe.
    return null;
  }
  if (!ref) return null;

  try {
    const resolution = await provider.resolve(ref);
    if (resolution.ok) {
      return {
        name: AUTH_CHECK_NAME,
        description: 'Connected with your Anthropic API key.',
        status: 'satisfied',
      };
    }
  } catch {
    // Resolution backend unavailable — treat as "no stored key" and fall through.
  }
  // Reference set but dangling: fall through to the host-login probe rather than
  // report missing, so a working host sign-in still reads as ready.
  return null;
}

/**
 * The one sign-in method that carries a renewal deadline DorkOS can read: the
 * stored claude.ai subscription login. An inherited `ANTHROPIC_API_KEY` or
 * `CLAUDE_CODE_OAUTH_TOKEN` has none.
 */
const SUBSCRIPTION_AUTH_METHOD = 'claude.ai';

/**
 * Describe a sign-in the CLI reports as working, adding its renewal deadline
 * when one can be read — and demoting it to `missing` when that deadline proves
 * the sign-in cannot actually serve a turn.
 *
 * This is the whole point of the expiry read. `claude auth status` answers from
 * stored state, so it says "signed in" for a credential that expired hours ago
 * and the runtime shows Ready until a real turn fails. Demoting here routes that
 * case through the SAME Connect path a signed-out CLI takes, so the fix a person
 * is offered is the fix they need.
 *
 * The deadline is only consulted for the subscription sign-in. Reading it for an
 * inherited env credential would describe a stored account that is not even the
 * one in use — and an unreadable deadline (`null`) always means "no information",
 * never a problem, so it leaves the answer exactly as the CLI reported it.
 *
 * @param status - What the CLI reported about this machine's sign-in.
 */
async function describeHostLogin(status: ClaudeAuthStatus): Promise<DependencyCheck> {
  const name = AUTH_CHECK_NAME;
  const signedIn: DependencyCheck = {
    name,
    description: 'Signed in to Claude.',
    status: 'satisfied',
  };

  if (status.authMethod !== SUBSCRIPTION_AUTH_METHOD) return signedIn;

  const deadlines = await readClaudeSignInDeadlines();
  if (!deadlines) return signedIn;

  const expiresAt = toIsoDeadline(deadlines.renewableUntil);
  if (isSignInUnusable(deadlines, Date.now())) {
    return {
      name,
      description: 'Your Claude sign-in has run out. Sign in again so your agents can work.',
      status: 'missing',
      installHint: CLAUDE_LOGIN_HINT,
      infoUrl: CLAUDE_INFO_URL,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
    };
  }
  return { ...signedIn, ...(expiresAt !== undefined ? { expiresAt } : {}) };
}

/**
 * Rungs 2 & 3 — the host's own Claude login OR an inherited env credential, both
 * read through {@link readClaudeAuthStatus}, the shared `claude auth status`
 * probe (codex-parity: the CLI is the single source of truth for auth state).
 * The eval harness asks that same probe the same question, so readiness here and
 * a credentialed eval boot can never disagree about this machine's sign-in.
 *
 * @param binary - The resolved `claude` binary (or `null`).
 */
async function checkHostLogin(binary: string | null): Promise<DependencyCheck> {
  const status = await readClaudeAuthStatus(binary);

  if (status?.loggedIn === true) return describeHostLogin(status);

  return {
    name: AUTH_CHECK_NAME,
    description: 'Sign in to Claude Code or add an API key so your agents can work.',
    status: 'missing',
    installHint: CLAUDE_LOGIN_HINT,
    infoUrl: CLAUDE_INFO_URL,
  };
}

/**
 * Check that Claude is authenticated — the DorkOS-stored credential first (rung
 * 1), then the host login / inherited env credential via the CLI (rungs 2 & 3).
 *
 * @param binary - The resolved `claude` binary (or `null`).
 * @param deps - Injectable config + credential-provider seams.
 */
async function checkAuthState(
  binary: string | null,
  deps: ClaudeDependencyDeps
): Promise<DependencyCheck> {
  const persisted = await checkPersistedCredential(deps);
  if (persisted) return persisted;
  return checkHostLogin(binary);
}

/**
 * Check whether Claude Code's external dependencies are satisfied: (a) a runnable
 * `claude` CLI binary — env override, SDK-bundled, provisioned, or on `PATH`, the
 * one ladder the SDK spawn seam walks too — and (b) an authenticated
 * Claude (a DorkOS-stored key, the host login, or an inherited env credential).
 * Surfaced by `GET /api/system/requirements`. The binary is resolved once and
 * shared by both checks; the two probes are otherwise independent.
 *
 * @param deps - Injectable config + credential-provider seams (production
 *   defaults resolve the module singletons).
 */
export async function checkClaudeDependencies(
  deps: ClaudeDependencyDeps = {}
): Promise<DependencyCheck[]> {
  const binary = await resolveClaudeBinaryPath();
  return Promise.all([checkCliBinary(binary), checkAuthState(binary, deps)]);
}
