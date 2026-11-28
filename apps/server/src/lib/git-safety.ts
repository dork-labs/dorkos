/**
 * Hardened environment for spawning `git` against an author-supplied URL.
 *
 * The marketplace's package fetch (`services/marketplace/lib/git/git-tree.ts`, for
 * every `github`, `url` and `git-subdir` source) and the workspace-template
 * clone (`template-downloader.execGitClone`) both hand a remote URL to `git`. Git's default configuration honours transport helpers such as `ext::`
 * (`ext::sh -c '<cmd>'`), which turn a clone/ls-remote into arbitrary command
 * execution — and that clone runs at *preview* time, before the install consent
 * gate. `GIT_ALLOW_PROTOCOL` is git's authoritative transport allowlist: it
 * overrides any `protocol.*.allow` config and confines git to the safe,
 * network-only transports we actually use. `GIT_TERMINAL_PROMPT` stops git from
 * blocking on an interactive credential prompt for a private URL.
 *
 * Every git spawn that touches an author-supplied URL — `git-tree.ts` and
 * `execGitClone` — must build its child env from this helper. It is the runtime backstop; the `git-subdir`
 * and `url` source schemas (`@dorkos/marketplace`) reject unsafe URL transports
 * at parse time.
 *
 * Every git command DorkOS runs itself also carries {@link internalGitArgs}
 * (DOR-2326): settings that stop a folder's own git configuration from running
 * a program (`@dorkos/shared/git-hardening`). {@link hardenedGitEnv} carries
 * them too, through git's environment settings (git 2.31+).
 *
 * @module lib/git-safety
 */
import { childEnvironment } from '@dorkos/shared/child-environment';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import {
  gitConfigArgs,
  gitProtectionCheck,
  internalGitConfig,
  withGitConfigEnv,
} from '@dorkos/shared/git-hardening';
import type { CheckResult } from '@dorkos/shared/health-schemas';
import { logger } from './logger.js';

/** A folder DorkOS just made for one git or gh call that keeps the real `GITHUB_TOKEN`. */
export interface FreshGitFolder {
  /** The empty folder, to run the call in. */
  readonly cwd: string;
  /** Keeps git from looking above it for a repository an agent could have planted. */
  readonly env: { readonly GIT_CEILING_DIRECTORIES: string };
  /** Removes the folder. */
  dispose(): void;
}

/**
 * Make an empty folder under the system temp folder for one `git-fetch` call
 * (`ls-remote`, a clone, `gh auth token`). Never the server's own working
 * folder: that is a project agents can write, and git reads its `.git/config`,
 * which can name a program that would see the token. A census test
 * (`__tests__/child-env-census.test.ts`) requires every such call to run in one.
 *
 * @returns The folder, its ceiling, and how to remove it.
 */
export function freshGitFolder(): FreshGitFolder {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'dorkos-git-'));
  return {
    cwd,
    env: { GIT_CEILING_DIRECTORIES: path.dirname(cwd) },
    dispose: () => fs.rmSync(cwd, { recursive: true, force: true }),
  };
}

/** How long `git --version` may take before git counts as unreadable. */
const GIT_VERSION_TIMEOUT_MS = 10_000;

/** Transports a marketplace fetch or ls-remote is allowed to use. Blocks `ext::`, `file::`, etc. */
const ALLOWED_GIT_PROTOCOLS = 'https:ssh:git';

/**
 * Build a child-process environment that confines `git` to safe transports.
 *
 * Inherits the parent environment (git needs `PATH`, `HOME`, proxy vars, and a
 * credential helper) and layers the protocol allowlist, and no lazy fetch, on top.
 *
 * @returns An env object suitable for `spawn`/`execFile` `env` options.
 */
export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return withGitConfigEnv(
    {
      // git needs PATH, HOME, proxy and credential vars. Every caller fetches into a
      // folder DorkOS just made (a template, a marketplace package), so the real
      // GITHUB_TOKEN stays; no other DorkOS name does.
      ...childEnvironment('git-fetch'),
      GIT_ALLOW_PROTOCOL: ALLOWED_GIT_PROTOCOLS,
      GIT_TERMINAL_PROMPT: '0',
      // No lazy fetch either (DOR-3667): a fresh clone is ours, but a read of a
      // missing object must never reach a remote some config named.
      GIT_NO_LAZY_FETCH: '1',
    },
    internalGitConfig()
  );
}

/**
 * The `-c` arguments every git command DorkOS runs itself puts before its
 * subcommand (DOR-2326): no implicitly found bare repository, no file-system
 * monitor, no hooks. `-c` works on every git version, unlike the environment
 * form.
 *
 * @returns The arguments, to spread ahead of the subcommand.
 */
export function internalGitArgs(): string[] {
  return gitConfigArgs(internalGitConfig());
}

/** The installed git's `--version` output, read once per process. */
let installedGitVersion: Promise<string | undefined> | undefined;

/**
 * `git --version`'s output, from one run per process: `undefined` when git is
 * not installed, `''` when it ran but said nothing readable (a timeout, a
 * mocked or broken child_process).
 */
function gitVersionOutput(): Promise<string | undefined> {
  // Bound here, not at load: many modules import this one only for its env,
  // under tests that mock `node:child_process` without `execFile`.
  installedGitVersion ??= (async () => {
    try {
      // No repository and no network: no token either.
      const { stdout } = await promisify(execFile)('git', ['--version'], {
        timeout: GIT_VERSION_TIMEOUT_MS,
        env: childEnvironment('git-local'),
      });
      return stdout;
    } catch (err) {
      const { code, stdout } = (err ?? {}) as NodeJS.ErrnoException & { stdout?: unknown };
      return code === 'ENOENT' ? undefined : typeof stdout === 'string' ? stdout : '';
    }
  })();
  return installedGitVersion;
}

/**
 * How much of the DOR-2326 protection the installed git gives, from one
 * `git --version` per process: the startup warning and the deep health line
 * both read it. Git 2.38 or later gives all of it
 * (`gitProtectionCheck` in `@dorkos/shared/git-hardening` says why).
 *
 * @returns The check line; never rejects.
 */
export async function installedGitProtection(): Promise<CheckResult> {
  return gitProtectionCheck(await gitVersionOutput());
}

/**
 * Whether git is installed, from the same one `git --version` per process.
 * A git that ran but said nothing readable counts as installed.
 *
 * @returns `false` only when git could not be found; never rejects.
 */
export async function isGitInstalled(): Promise<boolean> {
  return (await gitVersionOutput()) !== undefined;
}

/**
 * Log a plain warning at startup when the installed git gives agents less than
 * full protection. Never throws.
 */
export async function warnAboutGitProtection(): Promise<void> {
  const check = await installedGitProtection();
  if (check.status !== 'warn') return;
  logger.warn(`[Git] ${check.label}. ${check.detail ?? ''} ${check.fix ?? ''}`.trim());
}
