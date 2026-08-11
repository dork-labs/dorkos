/**
 * What this person actually uses, in the shape the ranker reads.
 *
 * The wiring layer under {@link palette-ranking}: it reads the two places the
 * cockpit records use today and hands back one map keyed exactly like the
 * corpus, so the scorer itself never touches a store.
 *
 * **Two sources, because there are still two stores.** `entities/interactions`
 * knows WHEN you last opened a thing, for every kind — conversations, rooms,
 * agents — and `use-agent-frecency.ts` knows HOW OFTEN, for agents only. Task
 * 3.3 retires the second into the first, at which point this file loses a
 * source and nothing else changes: the ranker's input shape is already the
 * union of what both provide.
 *
 * **The asymmetry that leaves, named rather than hidden:** only agents can reach
 * a full frecency score today. `frecencyScore` averages a how-recently half and
 * a how-often half, and rooms and conversations can only fill the first — so
 * however much you use one, its frecency is capped at 0.5 where a heavily-used
 * agent reaches ~1.0. It is an interim, accepted as such, and **task 3.3 owns
 * the fix**: one store keyed `type:id` that counts opens for every kind. Nothing
 * in `palette-ranking` changes when it lands.
 *
 * @module features/command-palette/model/use-palette-usage
 */
import { useMemo } from 'react';
import { interactionKey, useInteractionTimestamps } from '@/layers/entities/interactions';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import { useAgentFrecency } from './use-agent-frecency';
import type { UsageRecord } from './palette-ranking';

/** Everything the operator has opened, keyed by {@link interactionKey}. */
export type PaletteUsage = Readonly<Record<string, UsageRecord>>;

/**
 * Assemble the operator's usage history for ranking.
 *
 * The agent join is by `projectPath`, not by agent id. The two stores key agents
 * differently — the interaction store records the directory a person opened
 * (`agent:<projectPath>`), the older frecency store records the mesh id — and
 * the corpus ranks agents under the directory. Joining through the agent list is
 * what keeps the count and the timestamp landing on the same row instead of on
 * two rows that never meet.
 *
 * @param agents - Every agent the cockpit can see, for that join.
 */
export function usePaletteUsage(agents: readonly AgentPathEntry[]): PaletteUsage {
  const opened = useInteractionTimestamps();
  const { entries } = useAgentFrecency();

  return useMemo(() => {
    const usage: Record<string, UsageRecord> = {};

    for (const [key, iso] of Object.entries(opened)) {
      const parsed = Date.parse(iso);
      usage[key] = { lastUsedAt: Number.isNaN(parsed) ? null : parsed, useCount: 0 };
    }

    const pathById = new Map(agents.map((agent) => [agent.id, agent.projectPath]));
    for (const record of entries) {
      const projectPath = pathById.get(record.agentId);
      if (!projectPath) continue;
      const key = interactionKey('agent', projectPath);
      const existing = usage[key] ?? { lastUsedAt: null, useCount: 0 };
      // The newer of the two stamps wins. Both describe the same act — opening
      // this agent — recorded by two call sites that do not know about each
      // other, so taking the max is the only reading that cannot go backwards
      // when 3.3 folds one into the other.
      const recorded = record.timestamps[0] ?? null;
      usage[key] = {
        lastUsedAt:
          existing.lastUsedAt === null || (recorded !== null && recorded > existing.lastUsedAt)
            ? recorded
            : existing.lastUsedAt,
        useCount: Math.max(existing.useCount, record.totalCount),
      };
    }

    return usage;
  }, [opened, entries, agents]);
}
