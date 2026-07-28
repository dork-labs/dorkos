/**
 * Where the agents DorkOS creates actually land.
 *
 * `agents.defaultDirectory` ships as the string `~/.dork/agents`
 * ({@link DEFAULT_AGENTS_DIRECTORY}). That is a **portable spelling of
 * `{dorkHome}/agents`**, not a path to expand: `~/.dork` is the DorkOS data
 * directory only in a normal production install. A dev tree points `DORK_HOME`
 * at `apps/server/.temp/.dork`, a Docker deployment points it at a volume, and
 * a test points it at a temp dir — and in every one of those the agents DorkOS
 * creates belong under THAT directory, not under the operator's home.
 *
 * Expanding the default with `expandTilde()` ignored `DORK_HOME` entirely and
 * wrote new agents into the operator's live `~/.dork/agents` from a dev tree
 * (DOR-662). {@link resolveAgentsDirectory} is the seam that closes it, and it
 * is the only thing server code should use to turn `agents.defaultDirectory`
 * into a real path.
 *
 * A directory the person chose themselves is still theirs: any other value —
 * including a tilde path like `~/work/agents` — is expanded against their real
 * home, because that is what they meant when they typed it.
 *
 * @module lib/agents-home
 */
import path from 'path';
import { DEFAULT_AGENTS_DIRECTORY } from '@dorkos/shared/config-schema';
import { expandTilde } from './boundary.js';
import { resolveDorkHome } from './dork-home.js';

/**
 * `{dorkHome}/agents` — the directory DorkOS puts the agents it creates in,
 * derived from the resolved data directory rather than from the home directory.
 *
 * Resolved per call rather than cached: `DORK_HOME` is stable within a running
 * server, but the embedded transport and tests repoint it.
 */
export function resolveAgentsHome(): string {
  return path.join(resolveDorkHome(), 'agents');
}

/**
 * Turn a configured `agents.defaultDirectory` into an absolute path.
 *
 * The shipped default (and an absent or blank value) resolves to
 * {@link resolveAgentsHome}. Anything else is the person's own choice and is
 * tilde-expanded against their real home.
 *
 * Matching {@link DEFAULT_AGENTS_DIRECTORY} exactly is deliberate: the check
 * asks "is this still the value DorkOS shipped?", not "does this path look like
 * a home-relative dork directory?". On a normal install both answers resolve to
 * the same place, so the mapping changes nothing there — it only bites where
 * `DORK_HOME` has been redirected, which is exactly the case the default was
 * getting wrong.
 *
 * @param configured - The stored `agents.defaultDirectory`, if any.
 * @returns An absolute directory path, with no tilde left in it.
 */
export function resolveAgentsDirectory(configured?: string | null): string {
  const value = configured?.trim();
  if (!value || value === DEFAULT_AGENTS_DIRECTORY) return resolveAgentsHome();
  return expandTilde(value);
}
