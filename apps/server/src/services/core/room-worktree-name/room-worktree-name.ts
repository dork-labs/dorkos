/**
 * The name one agent's standing worktree takes in a room (spec `project-rooms`
 * §3.4): `<slug of the agent's name>-<digest of its workspace path>`.
 *
 * The digest is the identity half. It survives a rename, it is the same in
 * every room, and the reap and the transcript migration both match folders on
 * it alone. Pure functions of their inputs.
 *
 * Kernel: the rooms domain names and reaps the worktrees, and the Claude Code
 * runtime's transcript migration (computer side) finds an agent's old folders
 * by the same digest, so the scheme sits where both may import it.
 *
 * @module services/core/room-worktree-name/room-worktree-name
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import { slugifyAgentName } from '@dorkos/shared/validation';

/**
 * How many hex characters of the workspace-path digest ride in a worktree name.
 *
 * Eight — 32 bits. These are not adversarial inputs (an agent cannot choose
 * another agent's workspace path) and the population is the agents of one room,
 * so this is about accidents, not attacks: eight characters keeps the directory
 * name readable in `git worktree list` and in the explorer while making an
 * accidental clash between two agents in one room a non-event.
 */
export const ROOM_WORKTREE_DIGEST_CHARS = 8;

/**
 * How much of the agent's name survives into the directory name.
 *
 * `slugifyAgentName` allows 64, which with the digest would make some worktree
 * paths longer than the rest of the room home put together. Forty is still a
 * name a person recognizes at a glance.
 */
export const ROOM_WORKTREE_NAME_CHARS = 40;

/**
 * The directory name one agent's worktree takes in any room.
 *
 * Stable for an agent across rooms, restarts and other agents coming and
 * going — see `room-worktree-manager.ts`'s module doc for why the digest is
 * unconditional rather than a tiebreak.
 *
 * @param agentName - The agent's display name, or its registry name.
 * @param agentPath - The agent's workspace path, its identity anchor.
 * @returns A filesystem-safe, per-agent-stable directory name.
 */
export function roomWorktreeSlug(agentName: string, agentPath: string): string {
  const name = slugifyAgentName(agentName).slice(0, ROOM_WORKTREE_NAME_CHARS).replace(/-+$/, '');
  return `${name || 'agent'}-${roomWorktreeDigest(agentPath)}`;
}

/**
 * The identity half of a worktree name — the part that survives a rename.
 *
 * Its own function because the reap needs it without the agent's NAME: it holds
 * directory names and a set of busy agent paths, and matching on this suffix
 * is the only join available between the two.
 *
 * @param agentPath - The agent's workspace path.
 * @returns The digest that ends every worktree name for that agent.
 */
export function roomWorktreeDigest(agentPath: string): string {
  return createHash('sha256')
    .update(path.resolve(agentPath))
    .digest('hex')
    .slice(0, ROOM_WORKTREE_DIGEST_CHARS);
}
