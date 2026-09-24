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
import { gitConfigArgs, internalGitConfig, withGitConfigEnv } from '@dorkos/shared/git-hardening';

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
