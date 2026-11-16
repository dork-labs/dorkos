/**
 * What DorkOS owns a directory as — the one question `planAdopt` is handed and
 * never asks.
 *
 * `DirectoryOwnership` is an INPUT to the adopt engine. `@dorkos/harness` keeps
 * no knowledge of the dork home, which is the property that lets one engine run
 * offline in a terminal and inside this server; so both callers resolve the
 * answer from a path here, and the answer is the same one either way.
 *
 * Two directories are DorkOS's own, and everything else is somebody's project:
 *
 * 1. **An agent home** — a workspace under `<dorkHome>/agents`, created by
 *    `agent-creator` or `ensureDorkBot` ({@link isAgentHome}).
 * 2. **A room worktree** — a checkout under
 *    `<dorkHome>/rooms/<roomId>/worktrees/<slug>`, created by
 *    `RoomWorktreeManager`.
 *
 * Everything else is `plain`, which is what makes `harness.autoAdopt` inert in a
 * person's own repository by construction rather than by a check.
 *
 * This module is a LEAF: it imports `node:fs` and `node:path` and nothing else
 * at runtime. `dorkos harness adopt` loads it in a terminal to answer one path
 * question, and when it reached these helpers through `project-agent-workspace`
 * that question loaded ~200 server modules — the auth stack, the tunnel and
 * tracing among them — which is what timed SRC-11 out on CI (FG-005). Keep new
 * imports out of it.
 *
 * @module services/harness/directory-ownership
 */
import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { DirectoryOwnership } from '@dorkos/harness';

/**
 * Resolve a path through symlinks when it exists, else normalize it lexically.
 *
 * Containment has to be decided on the same kind of path on both sides. A dork
 * home reached through a symlink, or handed over as a relative `DORK_HOME`
 * (`resolveDorkHome` returns the env var verbatim), otherwise compares unequal
 * to the very workspace it contains — and the repair silently does nothing.
 *
 * Exported because the containment questions asked about the dork home are
 * asked in more than one file: {@link isAgentHome} and {@link isRoomWorktree}
 * here, and the agent-workspace pass in `project-agent-workspace.ts`.
 * Answering one on a differently-spelled path is the silent no-op this
 * function exists to prevent.
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
 * Exported because the distinction decides more than ownership. The
 * agent-created trigger (`project-on-agent-created.ts`) projects the REPO an
 * agent is pointed at and must not touch the homes, which `agent-creator` and
 * the boot backfill in `project-agent-workspace.ts` already own — and the two
 * answering that question differently is how a workspace ends up projected
 * twice with two different harness sets.
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

/**
 * What DorkOS owns `dir` as.
 *
 * Both halves resolve symlinks on both sides before comparing, because a dork
 * home reached by a different route still contains what it contains — a macOS
 * temp directory under a symlinked `/var` is the everyday case, and comparing
 * one spelling against the other is the silent no-op {@link canonicalize}
 * exists to prevent.
 *
 * @param dir - Absolute path to the directory a run is happening in.
 * @param dorkHome - Resolved DorkOS data directory (see `lib/dork-home.ts`).
 * @returns `agent-home`, `room-worktree`, or `plain`.
 */
export function resolveDirectoryOwnership(dir: string, dorkHome: string): DirectoryOwnership {
  if (isAgentHome(dir, dorkHome)) return 'agent-home';
  if (isRoomWorktree(dir, dorkHome)) return 'room-worktree';
  return 'plain';
}

/**
 * Whether `dir` is a room's working copy: `<dorkHome>/rooms/<id>/worktrees/<slug>`.
 *
 * The shape is matched rather than the room registry consulted, for two
 * reasons: the CLI has no registry to ask, and a worktree left behind by a room
 * that has since been deleted is still a directory DorkOS made and still not
 * somebody's project.
 *
 * @param dir - Absolute path to the directory.
 * @param dorkHome - Resolved DorkOS data directory.
 * @returns True when the path has that exact shape.
 */
function isRoomWorktree(dir: string, dorkHome: string): boolean {
  const rel = relative(canonicalize(join(dorkHome, 'rooms')), canonicalize(dir));
  if (rel === '' || rel.startsWith('..')) return false;
  const parts = rel.split(sep);
  return parts.length === 3 && parts[1] === 'worktrees';
}
