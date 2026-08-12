/**
 * What this person actually uses, in the shape the ranker reads.
 *
 * The wiring layer under {@link palette-ranking}: it reads the ONE place the
 * cockpit records use and hands back a map keyed exactly like the corpus, so the
 * scorer itself never touches a store.
 *
 * **One source, because there is one store now.** `entities/interactions` knows
 * both halves for every kind — WHEN you last opened a conversation, a channel or
 * an agent, and HOW OFTEN. The `dorkos:agent-frecency-v2` key that used to hold
 * the second half for agents alone has been folded into it and deleted from the
 * browser (`legacy-frecency-migration`), which is what closed the asymmetry this
 * file used to describe: every kind can now reach a full frecency score, where
 * before a channel you lived in was capped at half of what a heavily-used agent
 * could reach.
 *
 * The join by agent id is gone with it. Both facts arrive under the same key —
 * the directory — because one writer records them in one act.
 *
 * @module features/command-palette/model/use-palette-usage
 */
import { useMemo } from 'react';
import { useInteractionCounts, useInteractionTimestamps } from '@/layers/entities/interactions';
import type { UsageRecord } from './palette-ranking';

/** Everything the operator has opened, keyed by `interactionKey`. */
export type PaletteUsage = Readonly<Record<string, UsageRecord>>;

/**
 * Assemble the operator's usage history for ranking.
 *
 * Driven off the timestamp map rather than the count map, because the timestamp
 * is what the store prunes on: a key with a count and no timestamp is a record
 * the store no longer claims to know, and ranking it would resurrect a row
 * eviction has already dropped.
 */
export function usePaletteUsage(): PaletteUsage {
  const opened = useInteractionTimestamps();
  const counts = useInteractionCounts();

  return useMemo(() => {
    const usage: Record<string, UsageRecord> = {};
    for (const [key, iso] of Object.entries(opened)) {
      const parsed = Date.parse(iso);
      usage[key] = {
        lastUsedAt: Number.isNaN(parsed) ? null : parsed,
        useCount: counts[key] ?? 0,
      };
    }
    return usage;
  }, [opened, counts]);
}
