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
 * @module services/harness/directory-ownership
 */
import { join, relative, sep } from 'node:path';
import type { DirectoryOwnership } from '@dorkos/harness';
import { canonicalize, isAgentHome } from './project-agent-workspace.js';

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
