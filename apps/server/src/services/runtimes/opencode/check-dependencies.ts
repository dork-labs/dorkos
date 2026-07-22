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
import type { UserConfig } from '@dorkos/shared/config-schema';
import { configManager } from '../../core/config-manager.js';
import { credentialProvider, type CredentialProvider } from '../../core/credential-provider.js';
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

/** The provider whose models run locally (Ollama) — no credential is ever needed. */
const LOCAL_PROVIDER_ID = 'ollama';

/** Plain-language names for the providers a user connects OpenCode through. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  openrouter: 'OpenRouter',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  ollama: 'Ollama',
};

/** Human name for a provider id — a known name, or the raw id the user chose. */
function providerDisplayName(id: string): string {
  return PROVIDER_DISPLAY_NAMES[id] ?? id;
}

/** Minimal read surface of the config manager (injectable for tests). */
type ConfigReader = { get<K extends keyof UserConfig>(key: K): UserConfig[K] };

/**
 * The provider the user connected OpenCode through in DorkOS
 * (`runtimes.opencode.provider`), or `null` when none is set — the CLI-auth
 * users the readiness check falls back to. Read the same config seam the
 * readiness check consults, so the client's "Change power source" affordance and
 * the readiness projection stay in agreement.
 *
 * @param deps - Injectable config seam (defaults to the module singleton).
 */
export function getConnectedOpenCodeProvider(deps: { config?: ConfigReader } = {}): string | null {
  const config = deps.config ?? configManager;
  try {
    return config.get('runtimes').opencode.provider ?? null;
  } catch {
    // Config unavailable — no provider to report (the readiness check will fall
    // back to the CLI probe rather than guess).
    return null;
  }
}

/** Injectable seams for the credential-aware auth check (production defaults resolve the singletons). */
export interface OpenCodeDependencyDeps {
  /** Config reader (defaults to the module singleton). */
  config?: ConfigReader;
  /** Credential read port used to resolve a stored provider reference (defaults to the singleton). */
  credentialProvider?: CredentialProvider;
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

/**
 * Auth check name. MUST keep matching `deriveRuntimeReadiness`'s `/auth|login/i`
 * contract (`packages/shared/agent-runtime.ts`) so the runtime's Ready/Connect
 * projection keeps identifying this as the auth check.
 */
const AUTH_CHECK_NAME = 'OpenCode authentication';

/**
 * Whether OpenCode is satisfied by DorkOS's own persisted provider state, checked
 * BEFORE the CLI probe (the root-cause fix, spec §1). A provider the user
 * connected through DorkOS (OpenRouter, a Direct key, or local Ollama) is the
 * authoritative signal — the sidecar receives that credential at spawn via
 * `resolveOpenCodeProviderEnv`, so a working DorkOS connection must read as ready
 * even when the `opencode` CLI itself was never logged in.
 *
 * Returns:
 * - a `satisfied` check when a provider is set and its credential requirement is
 *   met (Ollama needs none; key providers need a reference that resolves through
 *   the same credential seam the sidecar uses);
 * - a `missing` check when a provider is set but its stored reference no longer
 *   resolves (honest degradation — the copy points at reconnecting);
 * - `null` when no provider is set in DorkOS, so the caller falls back to the CLI
 *   `opencode auth list` probe (CLI-authenticated users keep working).
 *
 * @param deps - Injectable config + credential-provider seams.
 */
async function checkPersistedProvider(
  deps: OpenCodeDependencyDeps
): Promise<DependencyCheck | null> {
  const config = deps.config ?? configManager;
  const provider = deps.credentialProvider ?? credentialProvider;
  const providerId = getConnectedOpenCodeProvider(deps);
  if (!providerId) return null;

  const name = providerDisplayName(providerId);

  // Local models (Ollama) need no credential — a selected provider is enough.
  // We deliberately do not block readiness on a reachability probe.
  if (providerId === LOCAL_PROVIDER_ID) {
    return {
      name: AUTH_CHECK_NAME,
      description: 'Using models on this computer (Ollama). Nothing you type leaves your machine.',
      status: 'satisfied',
    };
  }

  // Key providers: the stored reference must resolve through the same credential
  // seam the sidecar spawns with, or the connection is honestly broken.
  const ref = config.get('providers')[providerId];
  if (ref) {
    try {
      const resolution = await provider.resolve(ref);
      if (resolution.ok) {
        return {
          name: AUTH_CHECK_NAME,
          description: `Connected via ${name}.`,
          status: 'satisfied',
        };
      }
    } catch {
      // Resolution backend unavailable (e.g. credential provider not yet wired) —
      // treat as unresolved below rather than crashing the requirements report.
    }
  }

  return {
    name: AUTH_CHECK_NAME,
    description: `Your saved ${name} connection didn't work. Connect again to keep using OpenCode.`,
    status: 'missing',
    infoUrl: OPENCODE_INFO_URL,
  };
}

/**
 * Fall back to today's `opencode auth list` CLI probe. Preserves the pre-fix
 * behavior so users who authenticated the CLI directly (or supplied provider env
 * vars) keep reading as ready. `opencode auth list` reports stored credentials and
 * closes with an "N credentials" count; missing requires BOTH an explicit zero
 * count AND no active provider environment variables (their own "Environment"
 * section — NOTES.md §4). Local models never appear in either, so an unparseable
 * listing stays `satisfied` rather than alarming users who need no login.
 */
async function checkCliAuth(binary: string | null): Promise<DependencyCheck> {
  const description =
    'Provider credentials (opencode auth login) let OpenCode reach a model provider on your behalf.';

  if (binary) {
    try {
      const listing = await runOpenCode(binary, ['auth', 'list']);
      const count = CREDENTIAL_COUNT_PATTERN.exec(listing);
      if (count && Number(count[1]) === 0 && !ENVIRONMENT_COUNT_PATTERN.test(listing)) {
        return {
          name: AUTH_CHECK_NAME,
          description,
          status: 'missing',
          installHint: OPENCODE_LOGIN_HINT,
          infoUrl: OPENCODE_INFO_URL,
        };
      }
      return {
        name: AUTH_CHECK_NAME,
        description: 'Signed in with the OpenCode CLI.',
        status: 'satisfied',
      };
    } catch {
      // Non-zero exit — the CLI could not report auth state. Fall through.
    }
  }

  return {
    name: AUTH_CHECK_NAME,
    description,
    status: 'missing',
    installHint: OPENCODE_LOGIN_HINT,
    infoUrl: OPENCODE_INFO_URL,
  };
}

/**
 * Check that OpenCode can reach a model provider — reading DorkOS's own persisted
 * provider state first, then falling back to the `opencode auth list` CLI probe.
 *
 * @param binary - The resolved `opencode` binary (or `null`).
 * @param deps - Injectable config + credential-provider seams.
 */
async function checkAuthState(
  binary: string | null,
  deps: OpenCodeDependencyDeps
): Promise<DependencyCheck> {
  const persisted = await checkPersistedProvider(deps);
  if (persisted) return persisted;
  return checkCliAuth(binary);
}

/**
 * Check whether OpenCode's external dependencies are satisfied: (a) a runnable
 * `opencode` CLI binary — configured, provisioned, or on `PATH` — and (b) a
 * reachable model provider (a DorkOS-connected provider first, else a
 * CLI-authenticated one). Surfaced by `GET /api/system/requirements` once the
 * runtime is registered. Probes run concurrently and are each time-bounded.
 *
 * @param deps - Injectable config + credential-provider seams (production
 *   defaults resolve the module singletons).
 */
export async function checkOpenCodeDependencies(
  deps: OpenCodeDependencyDeps = {}
): Promise<DependencyCheck[]> {
  const binary = await resolveOpenCodeBinaryPath();
  return Promise.all([checkCliBinary(binary), checkAuthState(binary, deps)]);
}
