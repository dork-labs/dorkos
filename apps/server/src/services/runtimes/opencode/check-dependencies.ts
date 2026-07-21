/**
 * OpenCode dependency checks — verifies the `opencode` CLI binary and its
 * provider-credential state, the two external requirements for running
 * OpenCode agent sessions.
 *
 * The binary is resolved uniformly via the shared runtime-binary resolver: a
 * configured `runtimes.opencode.binaryPath` is authoritative, then an on-demand
 * provisioned install (ADR-0317), then `PATH`. OpenCode's binary is NOT vendored
 * by its SDK, so there is no vendored candidate. Probes are bounded and
 * non-blocking (shared run-probe helper).
 *
 * No live `opencode serve` probe happens here: the sidecar is lazily spawned
 * by the server-manager (P3), so at check time there is nothing to reach and
 * a cold probe would spawn a server as a side effect.
 *
 * @module services/runtimes/opencode/check-dependencies
 */
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { configManager } from '../../core/config-manager.js';
import { resolveRuntimeBinary } from '../shared/resolve-binary.js';
import { runBinaryProbe, findBinaryOnPath } from '../shared/run-probe.js';
import { resolveProvisionedOpenCodePath } from './provision.js';

/**
 * Each failure mode gets its own remedy so the onboarding screen never renders
 * the same command twice: the CLI check hands out the install command, the auth
 * check hands out the login command. When the CLI itself is missing the auth
 * check reports missing too, but the two hints stay distinct and correct.
 */
const OPENCODE_INSTALL_HINT = 'npm i -g opencode-ai';
const OPENCODE_LOGIN_HINT = 'opencode auth login';
const OPENCODE_INFO_URL = 'https://opencode.ai/docs/server';

/** Defensive cap on how long a CLI probe may run. */
const PROBE_TIMEOUT_MS = 5_000;

/**
 * `opencode auth list` closes its credentials section with an "N credentials"
 * summary line covering only stored `auth.json` entries; a literal zero is the
 * only positive signal that no provider is logged in there.
 */
const CREDENTIAL_COUNT_PATTERN = /\b(\d+)\s+credentials?\b/;

/**
 * Active provider env vars (e.g. `ANTHROPIC_API_KEY`) never count as stored
 * credentials — they print in a separate "Environment" section ending with an
 * "N environment variable(s)" outro (NOTES.md §4). A non-zero count means the
 * user is authenticated without any stored credential.
 */
const ENVIRONMENT_COUNT_PATTERN = /\b[1-9]\d*\s+environment variables?\b/;

/** Run the opencode binary with args and return trimmed stdout. Rejects on non-zero exit or timeout. */
function runOpenCode(binary: string, args: string[]): Promise<string> {
  return runBinaryProbe(binary, args, PROBE_TIMEOUT_MS);
}

/**
 * Resolve the `opencode` executable to probe.
 *
 * Precedence (ADR-0316, refined): a configured `runtimes.opencode.binaryPath` is
 * authoritative — when set but absent we report the dependency missing rather
 * than silently probing a different binary — then an on-demand provisioned
 * install, then an `opencode` on `PATH`.
 *
 * @returns Absolute path to the binary, or `null` when unresolvable.
 */
export function resolveOpenCodeBinaryPath(): Promise<string | null> {
  const { binaryPath } = configManager.get('runtimes').opencode;
  return resolveRuntimeBinary([
    { resolve: () => binaryPath, authoritative: true },
    { resolve: resolveProvisionedOpenCodePath },
    { resolve: () => findBinaryOnPath('opencode', PROBE_TIMEOUT_MS) },
  ]);
}

/** Check that the OpenCode CLI binary resolves and answers `--version`. */
async function checkCliBinary(binary: string | null): Promise<DependencyCheck> {
  const name = 'OpenCode CLI';
  const description = 'The OpenCode CLI powers OpenCode agent sessions in DorkOS.';

  if (binary) {
    try {
      const version = await runOpenCode(binary, ['--version']);
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
async function checkAuthState(binary: string | null): Promise<DependencyCheck> {
  const name = 'OpenCode authentication';
  const description =
    'Provider credentials (opencode auth login) let OpenCode reach a model provider on your behalf.';

  if (binary) {
    try {
      // `opencode auth list` reports stored credentials and closes with an
      // "N credentials" count. Missing requires BOTH an explicit zero count
      // AND no active provider environment variables (which print in their
      // own "Environment" section — NOTES.md §4). Local models (Ollama,
      // OpenAI-compatible endpoints) never appear in either, so an
      // unparseable listing stays "satisfied" rather than alarming users
      // who need no login.
      const listing = await runOpenCode(binary, ['auth', 'list']);
      const count = CREDENTIAL_COUNT_PATTERN.exec(listing);
      if (count && Number(count[1]) === 0 && !ENVIRONMENT_COUNT_PATTERN.test(listing)) {
        return {
          name,
          description,
          status: 'missing',
          installHint: OPENCODE_LOGIN_HINT,
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
    installHint: OPENCODE_LOGIN_HINT,
    infoUrl: OPENCODE_INFO_URL,
  };
}

/**
 * Check whether OpenCode's external dependencies are satisfied: (a) a runnable
 * `opencode` CLI binary — configured, provisioned, or on `PATH` — and (b)
 * stored provider credentials. Surfaced by `GET /api/system/requirements` once
 * the runtime is registered. Probes run concurrently and are each time-bounded.
 */
export async function checkOpenCodeDependencies(): Promise<DependencyCheck[]> {
  const binary = await resolveOpenCodeBinaryPath();
  return Promise.all([checkCliBinary(binary), checkAuthState(binary)]);
}
