/**
 * OpenCode dependency checks — verifies the `opencode` CLI binary and its
 * provider-credential state, the two external requirements for running
 * OpenCode agent sessions.
 *
 * No live `opencode serve` probe happens here: the sidecar is lazily spawned
 * by the server-manager (P3), so at check time there is nothing to reach and
 * a cold probe would spawn a server as a side effect.
 *
 * @module services/runtimes/opencode/check-dependencies
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { configManager } from '../../core/config-manager.js';

/** One remedy covers both failure modes: install the CLI, then log in. */
const OPENCODE_INSTALL_HINT = 'npm i -g opencode-ai && opencode auth login';
const OPENCODE_INFO_URL = 'https://opencode.ai/docs/server';

/** Defensive cap on how long a CLI probe may run. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * `opencode auth list` closes with an "N credentials" summary line; a literal
 * zero is the only positive signal that no provider is logged in.
 */
const CREDENTIAL_COUNT_PATTERN = /\b(\d+)\s+credentials?\b/;

/** Run the opencode binary with args and return trimmed stdout. Throws on non-zero exit. */
function runOpenCode(binary: string, args: string[]): string {
  // execFileSync with an argv array — no shell, no interpolation (spec §Security).
  return execFileSync(binary, args, {
    encoding: 'utf-8',
    timeout: PROBE_TIMEOUT_MS,
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

/**
 * Find an `opencode` binary on PATH, mirroring the Codex adapter's lookup.
 *
 * @returns Absolute path to an `opencode` on PATH, or `null` when none is found.
 */
function findOpenCodeOnPath(): string | null {
  const locator = process.platform === 'win32' ? 'where' : 'which';
  try {
    const found = execFileSync(locator, ['opencode'], { encoding: 'utf-8' })
      .split(/\r?\n/)[0] // `where` may return multiple matches
      .trim();
    if (found && existsSync(found)) return found;
  } catch {
    /* not on PATH */
  }
  return null;
}

/**
 * Resolve the `opencode` executable to probe.
 *
 * An explicitly configured `runtimes.opencode.binaryPath` is authoritative:
 * when it does not exist we report the dependency missing rather than
 * silently probing a different binary on PATH the user did not choose.
 *
 * @returns Absolute path to the binary, or `null` when unresolvable.
 */
export function resolveOpenCodeBinaryPath(): string | null {
  const { binaryPath } = configManager.get('runtimes').opencode;
  if (binaryPath !== null) return existsSync(binaryPath) ? binaryPath : null;
  return findOpenCodeOnPath();
}

/** Check that the OpenCode CLI binary resolves and answers `--version`. */
function checkCliBinary(binary: string | null): DependencyCheck {
  const name = 'OpenCode CLI';
  const description = 'The OpenCode CLI powers OpenCode agent sessions in DorkOS.';

  if (binary) {
    try {
      const version = runOpenCode(binary, ['--version']);
      return { name, description, status: 'satisfied', version };
    } catch {
      // Binary resolved but failed to launch — fall through to "missing".
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: OPENCODE_INSTALL_HINT,
    infoUrl: OPENCODE_INFO_URL,
  };
}

/** Check that OpenCode provider credentials exist (`opencode auth login`). */
function checkAuthState(binary: string | null): DependencyCheck {
  const name = 'OpenCode authentication';
  const description =
    'Provider credentials (opencode auth login) let OpenCode reach a model provider on your behalf.';

  if (binary) {
    try {
      // `opencode auth list` reports stored credentials and closes with an
      // "N credentials" count. Only an explicit zero is treated as missing:
      // environment-variable keys and local models (Ollama, OpenAI-compatible
      // endpoints) never appear as stored credentials, so an unparseable
      // listing stays "satisfied" rather than alarming users who need no login.
      const listing = runOpenCode(binary, ['auth', 'list']);
      const count = CREDENTIAL_COUNT_PATTERN.exec(listing);
      if (count && Number(count[1]) === 0) {
        return {
          name,
          description,
          status: 'missing',
          installHint: OPENCODE_INSTALL_HINT,
          infoUrl: OPENCODE_INFO_URL,
        };
      }
      return { name, description, status: 'satisfied' };
    } catch {
      // Non-zero exit — the CLI could not report auth state. Fall through.
    }
  }

  return {
    name,
    description,
    status: 'missing',
    installHint: OPENCODE_INSTALL_HINT,
    infoUrl: OPENCODE_INFO_URL,
  };
}

/**
 * Check whether OpenCode's external dependencies are satisfied: (a) a
 * runnable `opencode` CLI binary — from `runtimes.opencode.binaryPath` config
 * or PATH — and (b) stored provider credentials. Surfaced by
 * `GET /api/system/requirements` once the runtime is registered.
 */
export function checkOpenCodeDependencies(): DependencyCheck[] {
  const binary = resolveOpenCodeBinaryPath();
  return [checkCliBinary(binary), checkAuthState(binary)];
}
