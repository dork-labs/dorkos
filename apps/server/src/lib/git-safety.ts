/**
 * Hardened environment for spawning `git` against an author-supplied URL.
 *
 * The marketplace's package fetch (`services/marketplace/lib/git-tree.ts`, for
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
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  gitConfigArgs,
  gitProtectionCheck,
  internalGitConfig,
  withGitConfigEnv,
} from '@dorkos/shared/git-hardening';
import type { CheckResult } from '@dorkos/shared/health-schemas';
import { logger } from './logger.js';

/** How long `git --version` may take before git counts as unreadable. */
const GIT_VERSION_TIMEOUT_MS = 10_000;

/** Transports a marketplace fetch or ls-remote is allowed to use. Blocks `ext::`, `file::`, etc. */
const ALLOWED_GIT_PROTOCOLS = 'https:ssh:git';

/**
 * Build a child-process environment that confines `git` to safe transports.
 *
 * Inherits the parent environment (git needs `PATH`, `HOME`, proxy vars, and a
 * credential helper) and layers the protocol allowlist on top.
 *
 * @returns An env object suitable for `spawn`/`execFile` `env` options.
 */
export function hardenedGitEnv(): NodeJS.ProcessEnv {
  return withGitConfigEnv(
    {
      // eslint-disable-next-line no-restricted-syntax -- git must inherit PATH/HOME/proxy/credential vars; we only ADD the protocol allowlist on top.
      ...process.env,
      GIT_ALLOW_PROTOCOL: ALLOWED_GIT_PROTOCOLS,
      GIT_TERMINAL_PROMPT: '0',
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

/** The installed git's protection line, read once per process. */
let installedGitCheck: Promise<CheckResult> | undefined;

/**
 * How much of the DOR-2326 protection the installed git gives, from one
 * `git --version` per process: the startup warning and the deep health line
 * both read it. Git 2.38 or later gives all of it
 * (`gitProtectionCheck` in `@dorkos/shared/git-hardening` says why).
 *
 * @returns The check line; never rejects.
 */
export function installedGitProtection(): Promise<CheckResult> {
  // Bound here, not at load: many modules import this one only for its env,
  // under tests that mock `node:child_process` without `execFile`.
  installedGitCheck ??= promisify(execFile)('git', ['--version'], {
    timeout: GIT_VERSION_TIMEOUT_MS,
    env: hardenedGitEnv(),
  }).then(
    ({ stdout }) => gitProtectionCheck(stdout),
    (err: NodeJS.ErrnoException & { stdout?: string }) =>
      gitProtectionCheck(err.code === 'ENOENT' ? undefined : String(err.stdout ?? ''))
  );
  return installedGitCheck;
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
