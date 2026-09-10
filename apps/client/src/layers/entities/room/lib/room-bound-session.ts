/**
 * Which session an agent's work in one room runs in — the join between a room's
 * roster and its session bindings (DOR-1974).
 *
 * @module entities/room/lib/room-bound-session
 */
import {
  agentAuthorRef,
  type RoomSessionBinding,
  type RoomWithRoster,
} from '@dorkos/shared/room-schemas';

/**
 * The session this room has bound for the agent living at `agentPath`, or
 * `null` when it has none.
 *
 * **Two id spaces meet here, and the room knows only one of them.** A binding is
 * keyed by the author ULID the room minted for the agent the first time it
 * spoke; a caller holding an agent has its DIRECTORY. `AuthorRef.agentRef` is
 * `agentAuthorRef(projectPath)` and is the handle both sides carry, so the
 * roster is what turns one into the other — the same join `profileMemberIdOf`
 * exists for on the profile side, and the same rule: compare the ref, never a
 * display name.
 *
 * **`null` is an ordinary answer, not a failure.** An agent on a room's roster
 * that has not answered in it yet has no binding at all — a room binds a session
 * on its first turn, not at join — and neither does an agent that is not on this
 * roster. A caller must read `null` as "this room has nothing to say about where
 * this agent works" and fall back to its own default, never as "no session".
 *
 * @param room - The room on screen with its roster, or `undefined` when the read
 *   has not landed.
 * @param bindings - That room's `authorId → sessionId` pairs, or `undefined`
 *   when the read has not landed.
 * @param agentPath - The agent's project directory.
 * @returns The bound session id, or `null`.
 */
export function roomBoundSessionId(
  room: RoomWithRoster | undefined,
  bindings: readonly RoomSessionBinding[] | undefined,
  agentPath: string
): string | null {
  if (room === undefined || bindings === undefined) return null;
  const ref = agentAuthorRef(agentPath);
  const member = room.members.find(
    (row) => row.author.kind === 'agent' && row.author.agentRef === ref
  );
  if (member === undefined) return null;
  return bindings.find((binding) => binding.authorId === member.authorId)?.sessionId ?? null;
}
