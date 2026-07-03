/**
 * Codex dependency checks — verifies the `codex` CLI binary and its login
 * state, the two external requirements for running Codex agent sessions.
 *
 * The binary is resolved uniformly via the shared runtime-binary resolver
 * (ADR-0316): a configured `runtimes.codex.binaryPath` is authoritative, then
 * the SDK-vendored binary (present out of the box), then `PATH`. Probes are
 * bounded and non-blocking (shared run-probe helper) so a hung CLI degrades to
 * "missing" rather than stalling the event loop.
 *
 * @module services/runtimes/codex/check-dependencies
 */
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DependencyCheck } from '@dorkos/shared/agent-runtime';
import { configManager } from '../../core/config-manager.js';
import { resolveRuntimeBinary } from '../shared/resolve-binary.js';
import { runBinaryProbe, findBinaryOnPath } from '../shared/run-probe.js';

/** One remedy covers both failure modes: install the CLI, then log in. */
const CODEX_INSTALL_HINT = 'npm i -g @openai/codex && codex login';
const CODEX_INFO_URL = 'https://developers.openai.com/codex';

/** Defensive cap on how long a CLI probe may run. */
const PROBE_TIMEOUT_MS = 5_000;

/** Resolve modules relative to this file — ESM has no ambient `require`. */
const requireFrom = createRequire(import.meta.url);

/**
 * Rust target triple per `process.platform`/`process.arch`, mirroring
 * `@openai/codex-sdk`'s own binary resolution (its `bin/codex.js` and
 * `dist/index.js` map the same set). The vendored binary lives under
 * `vendor/<triple>/bin/codex`.
 */
const CODEX_TARGET_TRIPLE: Record<string, Record<string, string>> = {
  linux: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  android: { x64: 'x86_64-unknown-linux-musl', arm64: 'aarch64-unknown-linux-musl' },
  darwin: { x64: 'x86_64-apple-darwin', arm64: 'aarch64-apple-darwin' },
  win32: { x64: 'x86_64-pc-windows-msvc', arm64: 'aarch64-pc-windows-msvc' },
};

/** Per-platform vendor package that ships the codex binary, keyed by target triple. */
const CODEX_PLATFORM_PACKAGE: Record<string, string> = {
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
};

/**
 * Resolve the SDK-vendored `codex` executable, mirroring
 * `resolveBundledClaudeBinary()` for Claude.
 *
 * `@openai/codex-sdk` vendors the real CLI as a per-platform optional dependency
 * of its `@openai/codex` CLI package (`@openai/codex/vendor/<triple>/bin/codex`).
 * We locate it via the SAME two-hop `require.resolve` the SDK uses internally:
 * the CLI package (`@openai/codex`, a direct dependency so it resolves in every
 * environment) anchors the per-platform vendor package. This is a `require`
 * STRING against the CLI package, not an `@openai/codex-sdk` import, so it stays
 * within the codex adapter's ESLint SDK boundary. Returns the (existence-agnostic)
 * path; the shared resolver verifies the file exists.
 *
 * @returns Absolute path to the vendored binary, or `null` when this
 *   platform/arch has no vendored package installed.
 */
export function resolveCodexVendoredBinary(): string | null {
  const triple = CODEX_TARGET_TRIPLE[process.platform]?.[process.arch];
  if (!triple) return null;
  const platformPackage = CODEX_PLATFORM_PACKAGE[triple];
  if (!platformPackage) return null;

  try {
    // @openai/codex (the CLI) anchors resolution of its per-platform vendor
    // package, exactly as @openai/codex-sdk's own findCodexPath does.
    const codexPkgJson = requireFrom.resolve('@openai/codex/package.json');
    const codexRequire = createRequire(codexPkgJson);
    const platformPkgJson = codexRequire.resolve(`${platformPackage}/package.json`);
    const binary = process.platform === 'win32' ? 'codex.exe' : 'codex';
    return path.join(path.dirname(platformPkgJson), 'vendor', triple, 'bin', binary);
  } catch {
    // Optional platform package not installed (e.g. --no-optional) — no vendored binary.
    return null;
  }
}

/** Run the codex binary with args and return trimmed stdout. Rejects on non-zero exit or timeout. */
function runCodex(binary: string, args: string[]): Promise<string> {
  return runBinaryProbe(binary, args, PROBE_TIMEOUT_MS);
}

/**
 * Resolve the `codex` executable to probe.
 *
 * Precedence (ADR-0316, refined): a configured `runtimes.codex.binaryPath` is
 * authoritative — when set but absent we report the dependency missing rather
 * than silently probing a different binary — then the SDK-vendored binary, then
 * a `codex` on `PATH`.
 *
 * @returns Absolute path to the binary, or `null` when unresolvable.
 */
export function resolveCodexBinaryPath(): Promise<string | null> {
  const { binaryPath } = configManager.get('runtimes').codex;
  return resolveRuntimeBinary([
    { resolve: () => binaryPath, authoritative: true },
    { resolve: resolveCodexVendoredBinary },
    { resolve: () => findBinaryOnPath('codex', PROBE_TIMEOUT_MS) },
  ]);
}

/** Check that the Codex CLI binary resolves and answers `--version`. */
async function checkCliBinary(binary: string | null): Promise<DependencyCheck> {
  const name = 'Codex CLI';
  const description = 'The OpenAI Codex CLI powers Codex agent sessions in DorkOS.';

  if (binary) {
    try {
      const version = await runCodex(binary, ['--version']);
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
async function checkLoginState(binary: string | null): Promise<DependencyCheck> {
  const name = 'Codex authentication';
  const description =
    'A ChatGPT login or CODEX_API_KEY lets the Codex CLI reach OpenAI on your behalf.';

  if (binary) {
    try {
      // `codex login status` exits 0 when authenticated (ChatGPT OAuth or an
      // API key the child process inherits from the environment). The CLI is
      // the single source of truth for auth state — we never read auth.json
      // or environment variables ourselves.
      await runCodex(binary, ['login', 'status']);
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
 * `codex` CLI binary — configured, SDK-vendored, or on `PATH` — and (b) a live
 * login state. Surfaced by `GET /api/system/requirements` once the runtime is
 * registered. Probes run concurrently and are each time-bounded.
 */
export async function checkCodexDependencies(): Promise<DependencyCheck[]> {
  const binary = await resolveCodexBinaryPath();
  return Promise.all([checkCliBinary(binary), checkLoginState(binary)]);
}
