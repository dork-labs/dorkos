/**
 * Turns an agent going quiet into a notification.
 *
 * The mesh reconciler already fires on the transition EDGE — it calls its
 * liveness observers only when a pass actually flipped somebody — but what it
 * reports is a pair of counts, not who. So this reads the current unreachable
 * set and diffs it against the set it last announced. An agent that recovers
 * leaves the set, so if it goes quiet again a week later that is news again;
 * one that stays quiet for a day is said once.
 *
 * @module services/notifications/emitters/agent-liveness
 */
import { notify } from '../notification-service.js';

/** The one mesh read this needs: who is currently unreachable. */
export interface UnreachableAgents {
  listUnreachable(): Array<{ id: string; name: string; displayName?: string }>;
}

/** Watches an agent liveness source. Returned so boot can subscribe it. */
export type LivenessObserver = () => void;

/**
 * Build the liveness observer.
 *
 * @param mesh - The agent registry, for the current unreachable set.
 * @returns A function to hand to `meshCore.onLivenessChange`.
 */
export function agentLivenessObserver(mesh: UnreachableAgents): LivenessObserver {
  const announced = new Set<string>();

  return () => {
    const unreachable = mesh.listUnreachable();
    const live = new Set(unreachable.map((agent) => agent.id));

    // An agent that came back is forgotten, so a later disappearance is news
    // again rather than being swallowed as a repeat.
    for (const id of announced) {
      if (!live.has(id)) announced.delete(id);
    }

    for (const agent of unreachable) {
      if (announced.has(agent.id)) continue;
      announced.add(agent.id);
      void notify('agent.unreachable', {
        agentId: agent.id,
        agentName: agent.displayName ?? agent.name,
      });
    }
  };
}
