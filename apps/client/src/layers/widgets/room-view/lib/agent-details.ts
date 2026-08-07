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
 * @returns `agentRef` → how that agent runs, for every path that resolved.
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
      runtime: identity.label,
      ...(identity.modelLabel !== null && { model: identity.modelLabel }),
    });
  }
  return byRef;
}
