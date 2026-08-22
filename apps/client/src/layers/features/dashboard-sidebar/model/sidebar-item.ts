/**
 * The mark a sidebar row draws, and the one index that resolves it.
 *
 * A room's mark is the only thing in the panel that cannot be decided by the
 * model or by the row: a direct message draws its agent participants' FACES, so
 * answering it needs the room AND the fleet at once.
 *
 * **Why it lives at the feature layer.** Building it needs `entities/agent` AND
 * `entities/room`, and sibling entities may not import each other
 * (`.claude/rules/fsd-layers.md`). A feature may import both, so this is the
 * lowest layer where the two can meet. Moving room code into the agent entity to
 * dodge the rule is what produced a duplicate avatar system last time
 * (`specs/rooms/02-specification.md` §12.2).
 *
 * @module features/dashboard-sidebar/model/sidebar-item
 */
import type { SidebarItemRef } from '@dorkos/shared/config-schema';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { agentAuthorRef, type RoomSummary } from '@dorkos/shared/room-schemas';
import { identityMarkFaces, roomIdentityMark, type IdentityMark } from '@/layers/entities/room';

/**
 * The mark a sidebar row draws for its item — the sidebar's name for
 * {@link IdentityMark}, which every surface that draws a room now shares.
 *
 * The union and the room derivation moved to `entities/room` when the "Jump
 * back in" popover needed the same mark: features may not import each other's
 * models, so the alternative was a second derivation, and a second derivation
 * is how a direct message ends up with a face in one list and a letter in the
 * next (DOR-582, re-opened exactly that way).
 */
export type SidebarItemVisual = IdentityMark;

/**
 * The faces a mark carries, flattened — the entity's
 * {@link identityMarkFaces}, re-exported under the name every sidebar row
 * already calls it by.
 */
export const sidebarItemFaces = identityMarkFaces;

/**
 * A React key for one row, unique within its section.
 *
 * An ephemeral DOM identity, never a membership key: membership is always
 * compared with `sameSidebarItem` over the reference itself. The section's key
 * prefix is what lets a pinned reference sit beside its home copy.
 *
 * @param ref - The row's reference.
 */
export function sidebarItemKey(ref: SidebarItemRef): string {
  return ref.kind === 'agent' ? `agent:${ref.path}` : `room:${ref.roomId}`;
}

/** What {@link buildRoomVisualIndex} reads. */
export interface BuildRoomVisualsInput {
  /** Every agent `projectPath` the mesh knows. */
  agentPaths: readonly string[];
  /** Resolved manifests by `projectPath`. */
  agentsByPath: Readonly<Record<string, AgentManifest | null | undefined>>;
  /** Every non-archived room. */
  rooms: readonly RoomSummary[];
}

/**
 * Every room's mark, resolved once per render and read back by id.
 *
 * One pass over the fleet to build the `agentRef → path` map — a hash per agent,
 * which every direct message would otherwise recompute for the whole fleet — and
 * one pass over the rooms.
 *
 * **Rooms only.** This used to build an agent half beside the room one, a
 * `SidebarItem` per agent carrying a name, a last-active timestamp and a
 * resolved face. Nothing read it: the panel's rows come from the model, which
 * carries its own names and ordering, so the agent half was a fleet-wide walk
 * and a face hash per agent thrown away on every sidebar render
 * (`specs/sidebar-simplification` D8).
 *
 * @param input - The fleet and the rooms to read it against.
 */
export function buildRoomVisualIndex(
  input: BuildRoomVisualsInput
): ReadonlyMap<string, SidebarItemVisual> {
  const pathByAgentRef = new Map<string, string>();
  for (const path of input.agentPaths) pathByAgentRef.set(agentAuthorRef(path), path);

  const byRoomId = new Map<string, SidebarItemVisual>();
  for (const room of input.rooms) {
    byRoomId.set(
      room.id,
      roomIdentityMark({ room, agentsByPath: input.agentsByPath, pathByAgentRef })
    );
  }
  return byRoomId;
}
