/**
 * The Mesh agent, if any, rooted at a session's working directory.
 *
 * Nothing about a session names its agent directly — a session is a runtime
 * concept, an agent a Mesh one, and `cwd` is the only key the two share
 * (ADR-0043: the registry keys agents by their project directory). Every
 * caller here already has a `cwd` for other reasons (a title, a deep link)
 * and wants the SAME identity `Task.agentId` and `useRegisteredAgents()`
 * join on: the Mesh `AgentManifest.id` ULID, not a display name or a path.
 *
 * A process-wide singleton, set once at boot from the real `MeshCore`
 * ({@link setAgentPathLookup}) — mirrors `notification-service.ts` and
 * `agent-identity-service.ts`: the callers (a session-lifecycle projector
 * listener, an interaction-change listener) fire from module-level
 * subscriptions with no constructor to receive a dependency into, so they
 * read a singleton the same way `notify()` and `armEscalation()` do.
 *
 * @module services/mesh/agent-path-lookup
 */
import { logger } from '../../lib/logger.js';

/**
 * The subset of `MeshCore` this module needs. Structural rather than a
 * direct `MeshCore` import, so this file (and its callers, two blocking-tier
 * notification emitters) do not pull in the whole Mesh surface for one
 * lookup — `MeshCore` already satisfies this shape.
 */
export interface AgentPathLookup {
  /** The registered agent whose project directory is `projectPath`, if any. */
  getByPath(projectPath: string): { id: string } | undefined;
}

/** The wired lookup, or `undefined` before boot wires one in (or in a test). */
let lookup: AgentPathLookup | undefined;

/**
 * Wire the real Mesh registry in, or clear it.
 *
 * Called once at boot, right after `MeshCore` initializes. Tests set a fake
 * lookup the same way and clear it afterward so state cannot leak between
 * them.
 *
 * @param next - The registry to resolve through, or `undefined`.
 */
export function setAgentPathLookup(next: AgentPathLookup | undefined): void {
  lookup = next;
}

/**
 * The id of the Mesh agent rooted at `cwd`, or `undefined` when none
 * resolves.
 *
 * Every "we do not know" case lands here alike — no `cwd`, no lookup wired
 * yet (a session event that raced boot), no agent registered at that
 * directory, or a failed read — because attribution is a side channel: a
 * notification must still raise, agent-less, when nobody can say which agent
 * it was about.
 *
 * @param cwd - The session's working directory, when the caller knows one.
 */
export function resolveAgentIdForPath(cwd: string | undefined): string | undefined {
  if (!cwd || !lookup) return undefined;

  try {
    return lookup.getByPath(cwd)?.id;
  } catch (err) {
    logger.debug('[Mesh] Could not resolve the agent for a session directory', {
      cwd,
      err: String(err),
    });
    return undefined;
  }
}

/** Reset the singleton. Test-only seam, mirroring `agent-identity-service.ts`. */
export function resetAgentPathLookup(): void {
  lookup = undefined;
}
