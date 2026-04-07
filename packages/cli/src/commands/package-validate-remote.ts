/**
 * CLI handler for `dorkos package validate-remote <github-url>`.
 *
 * Shallow-clones a marketplace package repo into a temporary directory and
 * runs the same validations as `dorkos package validate`. Cleans up the temp
 * directory on every exit path via `try/finally`.
 *
 * Used by the `dorkos-community` GitHub Actions workflow to verify each
 * referenced package URL still hosts a valid package before merging changes
 * to `marketplace.json`.
 *
 * Returns the intended exit code rather than calling `process.exit` so the
 * top-level dispatcher in `cli.ts` retains the single source of truth for
 * process termination.
 *
 * Exit codes:
 *
 * - `0` — package is valid
 * - `1` — clone failed
 * - `2` — validation failed (one or more `error`-level issues)
 *
 * @module commands/package-validate-remote
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { validatePackage } from '@dorkos/marketplace/package-validator';

/** Parsed CLI arguments accepted by {@link runValidateRemote}. */
export interface ValidateRemoteArgs {
  /** Remote Git URL of the package repo to clone and validate. */
  url: string;
}

/** One-line usage string surfaced in error messages. */
const USAGE_LINE = 'Usage: dorkos package validate-remote <github-url>';

/**
 * Parse the raw argv slice that follows `dorkos package validate-remote`.
 *
 * Strict-positional only — no flags are accepted today. Throws an `Error`
 * (caught and formatted by the CLI dispatcher) when the positional URL is
 * missing.
 *
 * @param rawArgs - The argv slice after `package validate-remote`.
 * @returns A typed {@link ValidateRemoteArgs} object.
 */
export function parseValidateRemoteArgs(rawArgs: string[]): ValidateRemoteArgs {
  const positional = rawArgs.filter((a) => !a.startsWith('-'));
  if (positional.length === 0) {
    throw new Error(`Missing required <github-url> argument.\n${USAGE_LINE}`);
  }
  return { url: positional[0] };
}

/**
 * Implements `dorkos package validate-remote <github-url>`.
 *
 * Creates a temp directory, shallow-clones the repo into it, runs
 * {@link validatePackage}, and removes the temp directory before returning
 * (regardless of which path was taken — clone failure, validation failure,
 * or success).
 *
 * @param args - Parsed CLI arguments.
 * @returns The intended process exit code.
 */
export async function runValidateRemote(args: ValidateRemoteArgs): Promise<number> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'dorkos-validate-'));

  try {
    const cloned = await shallowClone(args.url, tmpDir);
    if (!cloned) {
      process.stderr.write(`Clone failed: ${args.url}\n`);
      return 1;
    }

    const result = await validatePackage(tmpDir);
    if (!result.ok) {
      const errors = result.issues
        .filter((issue) => issue.level === 'error')
        .map((issue) => `[${issue.code}] ${issue.message}`)
        .join('; ');
      process.stderr.write(`Validation failed: ${errors}\n`);
      return 2;
    }

    process.stdout.write(`OK: ${args.url}\n`);
    return 0;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Shallow-clone a remote Git repo into `dest` (`--depth 1`).
 *
 * Resolves to `true` when `git clone` exits with code `0`, `false`
 * otherwise. Errors from `spawn` itself (e.g. `git` not on `PATH`) also
 * resolve to `false` so the caller never has to handle exceptions from
 * this helper.
 *
 * Exported for testing — production callers should go through
 * {@link runValidateRemote}.
 *
 * @internal
 * @param url - Remote Git URL to clone.
 * @param dest - Absolute path to the (existing, empty) destination directory.
 * @returns `true` when the clone succeeded, `false` otherwise.
 */
export function shallowClone(url: string, dest: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn('git', ['clone', '--depth', '1', url, dest], { stdio: 'inherit' });
    child.on('exit', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
