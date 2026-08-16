/**
 * What a room knows about the AGENTS on its roster beyond their names — how
 * each one runs.
 *
 * A room entry stores an opaque author id and the roster carries a render cache
 * (ADR 260726-170126); neither says anything about the runtime an agent runs on
 * or the model it starts sessions with. That lives on the agent's own manifest,
 * which the room never sees. This module is the join between the two, and the
 * only key it is allowed to join on is `agentRef` — the stable handle derived
 * from an agent's directory (`agentAuthorRef`), never a display name, which two
 * agents can share.
 *
 * @module widgets/room-view/lib/agent-details
 */
import { agentAuthorRef } from '@dorkos/shared/room-schemas';
import type { AgentManifest, AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { resolveAgentVisual, type AgentVisual } from '@/layers/shared/lib';
import { formatRuntimeIdentity } from '@/layers/entities/runtime';

/**
 * How one agent on a roster runs, formatted for display.
 *
 * Both halves are already the strings a reader sees — the runtime's label from
 * the descriptor registry and the model's short label — so nothing downstream
 * has to know that a runtime is stored as `claude-code` or that OpenCode writes
 * its models as `provider/model`.
 */
export interface RosterAgentInfo {
  /**
   * The id the TEAM roster files this agent under — **the id the MESH REGISTRY
   * holds, and never the id written inside the agent's own manifest.**
   *
   * Three id spaces meet on one agent, and only two of them are usually equal:
   *
   * | id | where it lives | what it is for |
   * | -- | -------------- | -------------- |
   * | author ULID | the room's roster (`AuthorRef.id`) | who spoke in this room |
   * | registry id | `GET /api/mesh/agents/paths` | **the roster's key, so the profile's address** |
   * | manifest id | `.dork/agent.json` on disk | the agent's own record of itself |
   *
   * `GET /api/team` builds its agent rows straight off the registry
   * (`routes/team.ts` → `mesh.listWithHealth()` → `agentRow`'s `id: agent.id`),
   * so the registry id IS the roster id by construction. The manifest's own id
   * merely *usually* agrees: a directory re-registered after its manifest was
   * rewritten keeps the registry row it already had, and on one real machine 3
   * of 44 rows diverged. Opening `?profile=<manifest id>` for one of those
   * resolves to no roster row at all, and the drawer closes itself — a dead
   * click that looks exactly like a working one until you try it.
   *
   * So this field is populated from the mesh entry, not from the manifest, and
   * the two are deliberately not interchangeable here. See `useMeshMemberIds`,
   * which makes the same join for the sidebar and states the same rule.
   */
  memberId: string;
  /**
   * The agent's face, resolved the way every other surface resolves it.
   *
   * `resolveAgentVisual` on the MANIFEST — and, unlike {@link
   * RosterAgentInfo.memberId} above, that is correct: the face is hashed from
   * whatever id the sidebar and the message gutter hash, which is the manifest's.
   * The two fields read from different sources ON PURPOSE. One answers "where
   * does pressing this go", the other "what does this look like", and the
   * surfaces they have to match are different surfaces.
   *
   * Never the path: `resolveAgentVisual({ id: path })` would hash a directory
   * and land on a face nothing else in the cockpit draws.
   */
  visual: AgentVisual;
  /** Runtime display label, e.g. `'Claude Code'`. */
  runtime: string;
  /**
   * Short model label, e.g. `'opus'`. Absent when the agent names no model of
   * its own and inherits its runtime's default — which is a thing this client
   * genuinely does not know, so nothing is drawn for it.
   */
  model?: string;
}

/**
 * Index the fleet's manifests by the handle a room's roster names them with.
 *
 * **Only agents with a manifest get an entry, and that is the whole degradation
 * story.** An agent whose manifest could not be resolved — a failed read, a
 * directory that is no longer an agent — is simply absent from this map, so
 * every surface reading it draws nothing rather than a placeholder for a fact
 * nobody has. Same for the model half: absent means "inherits", and the label
 * is left off instead of guessing which default applies.
 *
 * **It takes the registry ENTRIES, not just their paths, and that is the whole
 * reason this signature changed.** The paths were all this needed to reach the
 * manifests, so the entry's `id` — the one the team roster is keyed by — used to
 * be dropped on the floor here and reconstructed from the manifest, which is a
 * different id space (see {@link RosterAgentInfo.memberId}). Taking the entries
 * whole means the honest id is already in hand at the moment the row is built.
 *
 * @param entries - Every registered agent as the mesh lists it, carrying both
 *   its registry id and its project directory.
 * @param manifests - Manifests keyed by that same path, as `resolveAgents`
 *   returns them; a `null` value is a path that resolved to no agent.
 * @returns `agentRef` → what this room knows about that agent, for every path
 *   that resolved.
 */
export function agentInfoByRef(
  entries: readonly AgentPathEntry[],
  manifests: Readonly<Record<string, AgentManifest | null>>
): Map<string, RosterAgentInfo> {
  const byRef = new Map<string, RosterAgentInfo>();
  for (const entry of entries) {
    const manifest = manifests[entry.projectPath];
    if (!manifest) continue;
    // The same formatter the status chip and the session list use, so an agent
    // reads as the same runtime and model everywhere it appears.
    const identity = formatRuntimeIdentity({ runtime: manifest.runtime, model: manifest.model });
    byRef.set(agentAuthorRef(entry.projectPath), {
      // The REGISTRY's id, not `manifest.id` — the line above is where a dead
      // profile link came from. See the field's own doc.
      memberId: entry.id,
      visual: resolveAgentVisual(manifest),
      runtime: identity.label,
      ...(identity.modelLabel !== null && { model: identity.modelLabel }),
    });
  }
  return byRef;
}

/**
 * Just the faces, keyed the same way — what a disc needs and nothing else.
 *
 * A projection rather than a second join, so the face a mention pill's hover
 * card reads and the face the masthead's roster draws cannot come from
 * different passes over the fleet.
 *
 * **The value stays an {@link AgentVisual} rather than widening to
 * `IdentityFaceOverride` here.** An `AgentVisual` IS one structurally — a colour
 * and an emoji the agent's own manifest answered for, exactly what outranks an
 * author row's render cache — so every override slot still takes this map. But
 * `RoomAvatar` asks for `AgentVisual` specifically, and widening at the source
 * would leave the room's own DM mark unable to use the very faces resolved for
 * it. Narrow at the source, widen at the slot.
 *
 * Surfaces below the roster take this map rather than a single face because
 * they resolve one author at a time and the join key is on the author, not on
 * the row: `MemberList` walks five members, and the timeline walks a page of
 * messages.
 *
 * @param info - What the room knows about its agents, from {@link agentInfoByRef}.
 * @returns `agentRef` → that agent's face.
 */
export function agentFacesByRef(
  info: ReadonlyMap<string, RosterAgentInfo>
): Map<string, AgentVisual> {
  const faces = new Map<string, AgentVisual>();
  for (const [ref, agent] of info) faces.set(ref, agent.visual);
  return faces;
}
