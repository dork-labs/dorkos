/**
 * Codex dependency checks — verifies the `codex` CLI binary and its login
 * state, the two external requirements for running Codex agent sessions.
 *
 * @module services/runtimes/codex/check-dependencies
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { configManager } from '../../core/config-manager.js';

/** One remedy covers both failure modes: install the CLI, then log in. */
const CODEX_INSTALL_HINT = 'npm i -g @openai/codex && codex login';
const CODEX_INFO_URL = 'https://developers.openai.com/codex';

/** Defensive cap on how long a CLI probe may run. */
const PROBE_TIMEOUT_MS = 5_000;

/** Run the codex binary with args and return trimmed stdout. Throws on non-zero exit. */
function runCodex(binary: string, args: string[]): string {
  // execFileSync with an argv array — no shell, no interpolation (spec §Security).
  return execFileSync(binary, args, {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Find a `codex` binary on PATH, mirroring the Claude adapter's lookup.
 *
 * @returns Absolute path to a `codex` on PATH, or `null` when none is found.
 */
function findCodexOnPath(): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(locator, ['codex'], { encoding: 'utf-8' })
      .split(/\r?\n/)[0] // `where` may return multiple matches
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }
  return null;
}

/**
 * Resolve the `codex` executable to probe.
 *
 * An explicitly configured `runtimes.codex.binaryPath` is authoritative: when
 * it does not exist we report the dependency missing rather than silently
 * probing a different binary on PATH the user did not choose.
 *
 * @returns Absolute path to the binary, or `null` when unresolvable.
 */
export function resolveCodexBinaryPath(): string | null {
  const { binaryPath } = configManager.get('runtimes').codex;
  if (binaryPath !== null) return existsSync(binaryPath) ? binaryPath : null;
  return findCodexOnPath();
}

/** Check that the Codex CLI binary resolves and answers `--version`. */
function checkCliBinary(binary: string | null): DependencyCheck {
  const name = 'Codex CLI';
  const description = 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.';

  if (binary) {
    try {
      const version = runCodex(binary, ['--version']);
      return { name, description, status: 'satisfied', version };
    } catch {
      // Binary resolved but failed to launch — fall through to "missing".
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: CODEX_INSTALL_HINT,
    infoUrl: CODEX_INFO_URL,
  };
}

/** Check that Codex login state exists (ChatGPT OAuth or `CODEX_API_KEY`). */
function checkLoginState(binary: string | null): DependencyCheck {
  const name = 'Codex authentication';
  const description =
    'A ChatGPT login or CODEX_API_KEY lets the Codex CLI reach OpenAI on your behalf.';

  if (binary) {
    try {
      // `codex login status` exits 0 when authenticated (ChatGPT OAuth or an
      // API key the child process inherits from the environment). The CLI is
      // the single source of truth for auth state — we never read auth.json
      // or environment variables ourselves.
      runCodex(binary, ['login', 'status']);
      return { name, description, status: 'satisfied' };
    } catch {
      // Non-zero exit — not logged in. Fall through to "missing".
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: CODEX_INSTALL_HINT,
    infoUrl: CODEX_INFO_URL,
  };
}

/**
 * Check whether Codex's external dependencies are satisfied: (a) a runnable
 * `codex` CLI binary — from `runtimes.codex.binaryPath` config or PATH — and
 * (b) a live login state. Surfaced by `GET /api/system/requirements` once the
 * runtime is registered.
 */
export function checkCodexDependencies(): DependencyCheck[] {
  const binary = resolveCodexBinaryPath();
  return [checkCliBinary(binary), checkLoginState(binary)];
}
