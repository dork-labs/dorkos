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
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeProvisionProgress, RuntimeProvisionResult } from '@dorkos/shared/transport';
import { resolveDorkHome } from '../../../../lib/dork-home.js';
import { logger, logError } from '../../../../lib/logger.js';

/**
 * `opencode-ai` version to install — pinned to match the `@opencode-ai/sdk`
 * already depended on by the server (`apps/server/package.json`), so the CLI
 * and the SDK the sidecar talks to never drift. Reversible: a future SDK bump
 * updates this in lockstep.
 */
export const OPENCODE_PACKAGE_VERSION = '1.18.15';

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
 * Read the installed `opencode-ai` version from the provisioned package's own
 * `package.json`. Returns `null` — never throws — when the file is missing,
 * unreadable, or malformed; callers treat that the same as a version mismatch
 * (safest default: re-provision rather than trust an unverifiable install).
 */
function readProvisionedOpenCodeVersion(): string | null {
  try {
    const raw = readFileSync(resolveProvisionedOpenCodePackageJsonPath(), 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      'version' in parsed &&
      typeof parsed.version === 'string'
    ) {
      return parsed.version;
    }
    return null;
  } catch {
    return null;
  }
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

  const installed = readProvisionedOpenCodeVersion();
  if (installed === OPENCODE_PACKAGE_VERSION) return binaryPath;

  logger.info(
    installed
      ? `[OpenCode] provisioned opencode-ai ${installed} != pinned ${OPENCODE_PACKAGE_VERSION} — re-provisioning`
      : `[OpenCode] provisioned opencode-ai version unreadable — re-provisioning`
  );
  const result = await provisionOpenCode();
  return result.ok ? (result.binaryPath ?? null) : null;
}

/** Package-manager-agnostic installer invocation: a scoped `npm install --prefix`. */
function npmInstallArgs(dir: string): { cmd: string; args: string[] } {
  return {
    cmd: process.platform === 'win32' ? 'npm.cmd' : 'npm',
    args: [
      'install',
      '--prefix',
      dir,
      '--no-audit',
      '--no-fund',
      '--loglevel=error',
      `opencode-ai@${OPENCODE_PACKAGE_VERSION}`,
    ],
  };
}

/** Condense installer failure into an honest, non-raw Connect message. */
function honestInstallError(detail: string): string {
  const firstLine = detail
    .split(/\r?\n/)
    .find((l) => l.trim())
    ?.trim();
  const suffix = firstLine ? ` (${firstLine})` : '';
  return `Could not install OpenCode${suffix}. Check your network and try again.`;
}

/** Best-effort removal of the (possibly partial) provisioning tree; never throws. */
async function cleanupProvisionDir(dir: string): Promise<void> {
  try {
    await rm(dir, { recursive: true, force: true });
  } catch (err) {
    logger.warn('[OpenCode] failed to clean up partial provisioning tree', logError(err));
  }
}

/**
 * Shared in-flight provisioning promise. Concurrent callers piggyback on one
 * install rather than racing a second `npm install` (and its cleanup `rm -rf`)
 * into the same scoped dir. Cleared once the install settles.
 */
let inFlightProvision: Promise<RuntimeProvisionResult> | null = null;

/**
 * Install `opencode-ai` on demand into the dork-home-scoped location.
 *
 * De-dupes concurrent calls (double-click, two tabs, a retry racing the
 * original): a second call piggybacks on the in-flight install instead of
 * spawning a second `npm install` that would race the first's cleanup. Streams
 * installer progress to `onProgress` (if supplied) and resolves to the terminal
 * result. On a non-zero exit, a spawn error, or an exit-0 that left no resolvable
 * binary, the partial tree is removed and the result carries an honest error.
 * Never rejects: failures are returned, not thrown, so the endpoint always
 * resolves to a Connect/error state.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @returns The terminal provisioning result.
 */
export async function provisionOpenCode(
  onProgress?: (progress: RuntimeProvisionProgress) => void
): Promise<RuntimeProvisionResult> {
  if (inFlightProvision) {
    onProgress?.({ stage: 'starting', message: 'OpenCode install already in progress…' });
    return inFlightProvision;
  }
  const run = runProvisionOpenCode(onProgress);
  inFlightProvision = run;
  try {
    return await run;
  } finally {
    inFlightProvision = null;
  }
}

/**
 * Perform one on-demand `opencode-ai` install into the dork-home-scoped location.
 * The concurrency guard lives in {@link provisionOpenCode}; this does the work.
 *
 * @param onProgress - Optional callback for streamed install progress frames.
 * @returns The terminal provisioning result.
 */
async function runProvisionOpenCode(
  onProgress?: (progress: RuntimeProvisionProgress) => void
): Promise<RuntimeProvisionResult> {
  const dir = resolveOpenCodeProvisionDir();
  const spec = `opencode-ai@${OPENCODE_PACKAGE_VERSION}`;
  onProgress?.({ stage: 'starting', message: `Installing ${spec}…` });

  try {
    await mkdir(dir, { recursive: true });
  } catch (err) {
    await cleanupProvisionDir(dir);
    const message = err instanceof Error ? err.message : String(err);
    onProgress?.({ stage: 'error', message });
    return { ok: false, error: honestInstallError(message) };
  }

  const { cmd, args } = npmInstallArgs(dir);

  return new Promise<RuntimeProvisionResult>((resolve) => {
    let stderr = '';
    let settled = false;
    const finish = (result: RuntimeProvisionResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });

    child.stdout?.on('data', (chunk: Buffer) => {
      onProgress?.({ stage: 'installing', message: chunk.toString() });
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      stderr += text;
      onProgress?.({ stage: 'installing', message: text });
    });

    child.once('error', (err: Error) => {
      void cleanupProvisionDir(dir).then(() => {
        onProgress?.({ stage: 'error', message: err.message });
        finish({ ok: false, error: honestInstallError(err.message) });
      });
    });

    child.once('exit', (code: number | null) => {
      if (code === 0) {
        const binaryPath = resolveProvisionedOpenCodePath();
        if (existsSync(binaryPath)) {
          onProgress?.({ stage: 'done', message: 'OpenCode installed.' });
          return finish({ ok: true, binaryPath });
        }
        // Installer succeeded but left no runnable binary — treat as failure.
      }
      void cleanupProvisionDir(dir).then(() => {
        const detail = stderr.trim() || `Installer exited with code ${code}`;
        onProgress?.({ stage: 'error', message: detail });
        finish({ ok: false, error: honestInstallError(detail) });
      });
    });
  });
}
