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
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
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
   * The id the TEAM roster files this agent under — its manifest ULID.
   *
   * The room and the roster do not share an id space for agents, and this is
   * the only bridge between them. A room entry stores an AUTHOR id, and an
   * agent's author row is a different ULID from its manifest (they are joined
   * server-side on `mintedForManifestId`); the roster's agent rows are keyed by
   * the manifest id. So a mention pill that wants to open a profile cannot use
   * the id it already has — it has to come through here, off the same manifest
   * the runtime label does.
   */
  manifestId: string;
  /**
   * The agent's face, resolved the way every other surface resolves it.
   *
   * `resolveAgentVisual` on the MANIFEST, so the emoji is hashed from the
   * manifest id — the same id the sidebar, the team roster and the member sheet
   * hash. That is the whole reason a room's faces have to come through here
   * rather than off the roster: a room entry carries an AUTHOR id, a different
   * ULID entirely, and hashing that would draw a confident face matching
   * nothing else on screen.
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
 * @param paths - The project directories of every registered agent, from mesh.
 * @param manifests - Manifests keyed by that same path, as `resolveAgents`
 *   returns them; a `null` value is a path that resolved to no agent.
 * @returns `agentRef` → what this room knows about that agent, for every path
 *   that resolved.
 */
export function agentInfoByRef(
  paths: readonly string[],
  manifests: Readonly<Record<string, AgentManifest | null>>
): Map<string, RosterAgentInfo> {
  const byRef = new Map<string, RosterAgentInfo>();
  for (const path of paths) {
    const manifest = manifests[path];
    if (!manifest) continue;
    // The same formatter the status chip and the session list use, so an agent
    // reads as the same runtime and model everywhere it appears.
    const identity = formatRuntimeIdentity({ runtime: manifest.runtime, model: manifest.model });
    byRef.set(agentAuthorRef(path), {
      manifestId: manifest.id,
      // The manifest, never the path: `resolveAgentVisual({ id: path })` would
      // hash a directory and land somewhere the sidebar never lands.
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
