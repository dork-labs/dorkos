/**
 * Hardened environment for spawning `git` against a marketplace-supplied URL.
 *
 * Marketplace package sources include `git-subdir` and `url` forms whose remote
 * URL is author-controlled. Git's default configuration honours transport
 * helpers such as `ext::` (`ext::sh -c '<cmd>'`), which turn a clone/ls-remote
 * into arbitrary command execution — and that clone runs at *preview* time,
 * before the install consent gate. `GIT_ALLOW_PROTOCOL` is git's authoritative
 * transport allowlist: it overrides any `protocol.*.allow` config and confines
 * git to the safe, network-only transports we actually use. `GIT_TERMINAL_PROMPT`
 * stops git from blocking on an interactive credential prompt for a private URL.
 *
 * Every git spawn that touches a marketplace URL must build its child env from
 * this helper. It is the runtime backstop; the `git-subdir` source schema
 * (`@dorkos/marketplace`) rejects unsafe URL transports at parse time.
 *
 * @module services/marketplace/source-resolvers/git-safety
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
