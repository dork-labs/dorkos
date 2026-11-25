/**
 * On-demand OpenCode provisioning (ADR-0317).
 *
 * OpenCode's binary is not vendored by its SDK, and bundling it into the base
 * install would violate the lean-base-install Non-Goal. Instead we install
 * `opencode-ai` on demand into a DorkOS-owned, dork-home-scoped location — never
 * a global `npm i -g` and never `os.homedir()` (hard rule; resolved via
 * `lib/dork-home.ts`). Because `opencode-ai` declares per-platform,
 * `os`/`cpu`-gated `optionalDependencies`, installing it pulls only the current
 * platform's binary. On success the provisioned binary is resolvable (the
 * check-dependencies resolver adds it as a candidate) and OpenCode flips to
 * Ready; on failure the partial tree is removed and the caller resolves back to
 * a single Connect action with an honest message.
 *
 * @module services/runtimes/opencode/providers/provision
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger } from '../../../../lib/logger.js';
import {
  createNpmProvisioner,
  readInstalledPackageVersion,
} from '../../shared/program/provision-npm.js';

/**
 * `opencode-ai` version to install — pinned to match the `@opencode-ai/sdk`
 * already depended on by the server (`apps/server/package.json`), so the CLI
 * and the SDK the sidecar talks to never drift. Reversible: a future SDK bump
 * updates this in lockstep.
 */
export const OPENCODE_PACKAGE_VERSION = '1.19.3';

/** Dork-home-scoped directory the provisioned `opencode-ai` package is installed into. */
export function resolveOpenCodeProvisionDir(): string {
  return path.join(resolveDorkHome(), 'runtimes', 'opencode');
}

/**
 * Absolute path to the provisioned `opencode` binary (the npm-created bin shim
 * under the scoped install), existence-agnostic — the shared resolver verifies
 * it exists.
 */
export function resolveProvisionedOpenCodePath(): string {
  const bin = process.platform === 'win32' ? 'opencode.cmd' : 'opencode';
  return path.join(resolveOpenCodeProvisionDir(), 'node_modules', '.bin', bin);
}

/**
 * Absolute path to the provisioned `opencode-ai` package's own `package.json` —
 * the source of truth for which version is actually installed, read to detect
 * drift from {@link OPENCODE_PACKAGE_VERSION} after a pin bump ships.
 */
export function resolveProvisionedOpenCodePackageJsonPath(): string {
  return path.join(resolveOpenCodeProvisionDir(), 'node_modules', 'opencode-ai', 'package.json');
}

/**
 * Resolve the provisioned `opencode` binary, re-provisioning first when the
 * installed `opencode-ai` version has drifted from the current
 * {@link OPENCODE_PACKAGE_VERSION} pin (the fix for DOR-1034: a version bump to
 * the pin previously left an existing provisioned install stale forever, since
 * nothing ever re-checked it after the initial install).
 *
 * Returns `null` when there is nothing usable — no provisioned install exists
 * yet (the ordinary "not provisioned" case, left to the normal Connect/Install
 * flow), or a re-provision attempt failed — so resolution falls through to the
 * next candidate (`PATH`) exactly as a missing binary always has. Never throws.
 */
export async function ensureProvisionedOpenCodeVersion(): Promise<string | null> {
  const binaryPath = resolveProvisionedOpenCodePath();
  if (!existsSync(binaryPath)) return null;

  const installed = readInstalledPackageVersion(resolveProvisionedOpenCodePackageJsonPath());
  if (installed === OPENCODE_PACKAGE_VERSION) return binaryPath;

  logger.info(
    installed
      ? `[OpenCode] provisioned opencode-ai ${installed} != pinned ${OPENCODE_PACKAGE_VERSION} — re-provisioning`
      : `[OpenCode] provisioned opencode-ai version unreadable — re-provisioning`
  );
  const result = await provisionOpenCode();
  return result.ok ? (result.binaryPath ?? null) : null;
}

/**
 * Install `opencode-ai` on demand into the dork-home-scoped location, through
 * the shared npm provisioner: concurrent calls share one install, progress
 * streams to `onProgress`, a failed install is removed and answers with an
 * honest error. Never rejects.
 */
export const provisionOpenCode = createNpmProvisioner({
  runtime: 'opencode',
  label: 'OpenCode',
  logTag: '[OpenCode]',
  dir: resolveOpenCodeProvisionDir,
  spec: () => `opencode-ai@${OPENCODE_PACKAGE_VERSION}`,
  installedBinary: () => {
    const binaryPath = resolveProvisionedOpenCodePath();
    return existsSync(binaryPath) ? binaryPath : null;
  },
});
