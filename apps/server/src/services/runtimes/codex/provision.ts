/**
 * On-demand Codex provisioning (ADR-0317).
 *
 * `@openai/codex-sdk` vendors the Codex CLI out of the box, so Codex is usually
 * resolvable without any install. When that vendored binary is absent — a
 * `--no-optional` install, a platform whose vendor package never landed, or a
 * stripped image — the one-click Connect action installs the `@openai/codex` CLI
 * on demand into a DorkOS-owned, dork-home-scoped location, never a global
 * `npm i -g` and never `os.homedir()` (hard rule; resolved via `lib/dork-home.ts`).
 * Because `@openai/codex` declares per-platform, `os`/`cpu`-gated
 * `optionalDependencies`, installing it pulls only the current platform's binary.
 * On success the provisioned binary is resolvable (the check-dependencies resolver
 * adds it as a candidate) and Codex flips to Ready; on failure the partial tree is
 * removed and the caller resolves back to a single Connect action with an honest
 * message.
 *
 * @module services/runtimes/codex/provision
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../lib/dork-home.js';
import { createNpmProvisioner } from '../shared/program/provision-npm.js';

/**
 * `@openai/codex` version to install — pinned to match the `@openai/codex` CLI
 * and `@openai/codex-sdk` the server already depends on (`apps/server/package.json`),
 * so the provisioned CLI and the SDK never drift. Reversible: a future SDK bump
 * updates this in lockstep.
 */
export const CODEX_PACKAGE_VERSION = '0.163.0';

/** Dork-home-scoped directory the provisioned `@openai/codex` package is installed into. */
export function resolveCodexProvisionDir(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'codex');
}

/**
 * Absolute path to the provisioned `codex` binary (the npm-created bin shim under
 * the scoped install), existence-agnostic — the shared resolver verifies it exists.
 */
export function resolveProvisionedCodexPath(): string {
  const bin = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  return path.join(resolveCodexProvisionDir(), 'node_modules', '.bin', bin);
}

/**
 * Install `@openai/codex` on demand into the dork-home-scoped location, through
 * the shared npm provisioner: concurrent calls share one install, progress
 * streams to `onProgress`, a failed install is removed and answers with an
 * honest error. Never rejects.
 */
export const provisionCodex = createNpmProvisioner({
  runtime: 'codex',
  label: 'Codex',
  logTag: '[Codex]',
  dir: resolveCodexProvisionDir,
  spec: () => `@openai/codex@${CODEX_PACKAGE_VERSION}`,
  installedBinary: () => {
    const binaryPath = resolveProvisionedCodexPath();
    return existsSync(binaryPath) ? binaryPath : null;
  },
});
