/** Path-only ownership helpers, shared without loading workspace provisioning. */
import { realpathSync } from 'node:fs';
import { join, relative, resolve, isAbsolute } from 'node:path';

/**
 * Resolve a path through symlinks when it exists, else normalize it lexically.
 *
 * Containment has to be decided on the same kind of path on both sides. A dork
 * home reached through a symlink, or handed over as a relative `DORK_HOME`
 * (`resolveDorkHome` returns the env var verbatim), otherwise compares unequal
 * to the very workspace it contains — and the repair silently does nothing.
 *
 * Exported because the containment questions asked about the dork home are
 * asked in more than one file: `directory-ownership.ts` asks the same question
 * about a room's working copy, and answering it on a differently-spelled path
 * is the silent-no-op this function exists to prevent.
 *
 * @param p - Path to canonicalize.
 * @returns The real path, or the lexically resolved one when it does not exist.
 */
export function canonicalize(p: string): string {
  const absolute = resolve(p);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute;
  }
}

/**
 * Whether `dir` lives inside the agents directory this dork home owns
 * (`<dorkHome>/agents/`) — i.e. whether it is an agent HOME DorkOS created
 * rather than a repository somebody pointed an agent at.
 *
 * Exported because the distinction decides more than this pass. The
 * agent-created trigger (`project-on-agent-created.ts`) projects the REPO an
 * agent is pointed at and must not touch the homes, which `agent-creator` and
 * the workspace boot backfill already own — and the two answering that
 * question differently is how a workspace ends up projected twice with two
 * different harness sets.
 *
 * Both sides are resolved through symlinks first, so a home reached by a
 * different route still matches — and, in the other direction, a symlink planted
 * inside the agents directory that points at somebody's repository does not.
 *
 * Deliberately scoped to `<dorkHome>/agents` and nothing else. Since DOR-662
 * that is where DorkOS puts every agent it creates — production, dev, Docker and
 * tests alike — because the shipped `agents.defaultDirectory` is a portable
 * spelling of `{dorkHome}/agents` rather than a path to expand
 * (`lib/agents-home.ts`). Do not widen it to accept that setting blindly: a
 * person who points it somewhere of their own means somewhere of their own, and
 * those agents stay out of scope for an unprompted boot-time write (DOR-664).
 *
 * @param dir - Absolute path to an agent workspace.
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns True when `dir` is a descendant of `<dorkHome>/agents`.
 */
export function isAgentHome(dir: string, dorkHome: string): boolean {
  const rel = relative(canonicalize(join(dorkHome, 'agents')), canonicalize(dir));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}
