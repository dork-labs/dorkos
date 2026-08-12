/**
 * The mark a row draws for a room — the one derivation, for every surface that
 * draws one.
 *
 * **Why it lives in the room entity.** It used to live in the sidebar's item
 * view model, which was the lowest layer that could see both a room and the
 * fleet at the time. That worked until a second surface needed the same mark:
 * the "Jump back in" popover is a different feature, features may not import
 * each other's models (`.claude/rules/fsd-layers.md`), and the mark it fell
 * back to instead was the room's own letter disc — re-opening DOR-582 on the
 * surface sitting right beside the sidebar that fixed it.
 *
 * Nothing here imports the agent entity, so the sibling-entity rule is intact:
 * a face is an {@link AgentVisual} from `shared/lib`, and the fleet arrives as
 * plain data the caller already holds.
 *
 * @module entities/room/lib/identity-mark
 */
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { RoomRosterEntry, RoomSummary } from '@dorkos/shared/room-schemas';
import { resolveAgentVisual, type AgentVisual } from '@/layers/shared/lib';

/**
 * The mark a row draws for the thing it points at.
 *
 * The three arms are the three answers, not three shapes of the same answer:
 *
 * - `identity` — one agent's face. An agent row, and a one-to-one direct
 *   message, which IS that agent as far as the reader is concerned.
 * - `stack` — several agents' faces, for a direct message with more than one
 *   agent in it. A group conversation's title already names everyone; the mark
 *   is what tells you it is a group at a glance.
 * - `sigil` — no face at all: the room's own mark, which is `#` for a channel.
 *   A channel is anchored to a topic rather than to a participant
 *   (`specs/rooms/02-specification.md` §14.4), so giving it a face would be the
 *   same category error as giving it a `cwd`. It is also the honest answer for a
 *   direct message whose agents this cockpit cannot resolve — the room's own
 *   letter disc is stable and true, where a guessed face is neither.
 */
export type IdentityMark =
  | { kind: 'identity'; visual: AgentVisual }
  | { kind: 'stack'; visuals: AgentVisual[] }
  | { kind: 'sigil' };

/** What {@link roomIdentityMark} needs: the room, read against the fleet. */
export interface RoomIdentityMarkInput {
  /** The room, as the list query carries it. */
  room: RoomSummary;
  /** Resolved manifests by `projectPath`, for a direct message's faces. */
  agentsByPath: Readonly<Record<string, AgentManifest | null | undefined>>;
  /** `agentAuthorRef(projectPath)` → `projectPath`, so a participant can be matched to the fleet. */
  pathByAgentRef: ReadonlyMap<string, string>;
}

/**
 * The mark for a room: its participants' faces for a direct message, its own
 * sigil otherwise.
 *
 * **This is where DOR-582 is fixed.** A direct message used to draw a letter
 * where its agent's face belongs, because the only emoji it had to work with was
 * `AuthorRef.emoji` — a render cache the server fills in only for an agent that
 * has an emoji explicitly stored on its manifest, which almost none do. Hashing
 * the `AuthorRef.id` instead would be worse than a letter: that id is a row in
 * the `authors` table, unrelated to the manifest ULID the agent's own row hashes
 * from, so it would draw a confidently WRONG face.
 *
 * So the participant is matched back to the fleet on its `agentRef` — the stable
 * handle derived from the agent's directory, never a display name — and the face
 * is resolved from the manifest, exactly as an agent's own row does. That is the
 * only way a DM, an agent row and every other surface can agree.
 *
 * @param input - The room and the fleet it is read against.
 */
export function roomIdentityMark({
  room,
  agentsByPath,
  pathByAgentRef,
}: RoomIdentityMarkInput): IdentityMark {
  if (room.kind !== 'dm') return { kind: 'sigil' };
  const visuals: AgentVisual[] = [];
  for (const author of room.participants ?? []) {
    if (author.kind !== 'agent' || author.agentRef === undefined) continue;
    const path = pathByAgentRef.get(author.agentRef);
    // An agent this cockpit cannot see — removed, or on another machine — has no
    // manifest to hash, and hashing anything else would invent a face. It drops
    // out, and a DM left with none falls through to the room's own mark.
    if (path === undefined) continue;
    const agent = agentsByPath[path];
    visuals.push(agent ? resolveAgentVisual(agent) : resolveAgentVisual({ id: path }));
  }
  if (visuals.length === 0) return { kind: 'sigil' };
  if (visuals.length === 1) return { kind: 'identity', visual: visuals[0]! };
  return { kind: 'stack', visuals };
}

/**
 * The faces of the agents on a roster, in roster order, for a caller that has
 * already resolved the fleet into faces keyed by `agentRef`.
 *
 * **The same rule as {@link roomIdentityMark}, entered from the other end.**
 * That function is for a caller holding raw manifests (the sidebar, which reads
 * the fleet to draw every row); this is for one holding a room already open and
 * a resolved faces map (the masthead, and the member sheet's own `roomVisuals`).
 * Both join participants to the fleet on `agentRef` — never a display name,
 * never the author id.
 *
 * They part company on the agent the fleet could NOT name. This one drops it,
 * so a room falls back to its own letter rather than showing a face nothing
 * else on screen shows. {@link roomIdentityMark} hashes the agent's DIRECTORY
 * instead (`resolveAgentVisual({ id: path })`), which lands on a face the
 * sidebar's own agent row does not draw — a pre-existing divergence, tracked
 * separately, and deliberately not changed here.
 *
 * It does not check the room's kind, because `RoomAvatar` already does: only a
 * direct message draws faces, and a channel ignores whatever it is handed. One
 * component deciding that is why the masthead and the sidebar cannot disagree
 * about which rooms wear a face.
 *
 * @param members - The room's roster, as an open room carries it.
 * @param facesByRef - Faces keyed by `agentRef`, resolved against the fleet.
 */
export function rosterAgentFaces(
  members: readonly RoomRosterEntry[],
  facesByRef: ReadonlyMap<string, AgentVisual>
): AgentVisual[] {
  const faces: AgentVisual[] = [];
  for (const { author } of members) {
    if (author.kind !== 'agent' || author.agentRef === undefined) continue;
    const face = facesByRef.get(author.agentRef);
    if (face !== undefined) faces.push(face);
  }
  return faces;
}

/**
 * The faces a mark carries, flattened — one for an `identity`, several for a
 * `stack`, none for a `sigil`.
 *
 * Exists so a row can hand `RoomAvatar` "the faces to draw" without re-deriving
 * the union, which is the split that let two avatar systems co-exist before.
 *
 * @param mark - The row's mark.
 */
export function identityMarkFaces(mark: IdentityMark): AgentVisual[] {
  if (mark.kind === 'sigil') return [];
  return mark.kind === 'identity' ? [mark.visual] : mark.visuals;
}
