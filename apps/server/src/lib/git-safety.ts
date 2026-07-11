/**
 * Hardened environment for spawning `git` against an author-supplied URL.
 *
 * Marketplace package sources (`git-subdir`, `url`) and the shared clone
 * primitive (`template-downloader.execGitClone`) all hand a remote URL to
 * `git`. Git's default configuration honours transport helpers such as `ext::`
 * (`ext::sh -c '<cmd>'`), which turn a clone/ls-remote into arbitrary command
 * execution — and that clone runs at *preview* time, before the install consent
 * gate. `GIT_ALLOW_PROTOCOL` is git's authoritative transport allowlist: it
 * overrides any `protocol.*.allow` config and confines git to the safe,
 * network-only transports we actually use. `GIT_TERMINAL_PROMPT` stops git from
 * blocking on an interactive credential prompt for a private URL.
 *
 * Every git spawn that touches an author-supplied URL — the marketplace
 * resolvers (`git-subdir`, `package-fetcher`) and `execGitClone` — must build
 * its child env from this helper. It is the runtime backstop; the `git-subdir`
 * and `url` source schemas (`@dorkos/marketplace`) reject unsafe URL transports
 * at parse time.
 *
 * @module lib/git-safety
 */

/** Transports a marketplace clone/ls-remote is allowed to use. Blocks `ext::`, `file::`, etc. */
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
  return {
    // eslint-disable-next-line no-restricted-syntax -- git must inherit PATH/HOME/proxy/credential vars; we only ADD the protocol allowlist on top.
    ...process.env,
    GIT_ALLOW_PROTOCOL: ALLOWED_GIT_PROTOCOLS,
    GIT_TERMINAL_PROMPT: '0',
  };
}
