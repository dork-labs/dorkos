/**
 * Fleet-wide "is any of these agents working?" rollup (DOR-329).
 *
 * Backs the collapsed-group activity dot: a collapsed group hides its member
 * rows, so their individual status indicators are not mounted. Rather than
 * subscribe one status hook per hidden member (a perf landmine at 100+ agents),
 * this reads the global session-list store ONCE and folds every live status by
 * cwd, returning a single boolean — O(1) store subscriptions regardless of how
 * many paths are passed.
 *
 * @module entities/session/model/use-agents-aggregate-status
 */
import { useCallback } from 'react';
import { useSessionListStore } from './session-list-store';
import { foldLiveKindsByPath } from './agent-attention';

/** Options for {@link useAgentsAggregateStatus}. */
export interface UseAgentsAggregateStatusOptions {
  /**
   * Muted agent paths to exclude from the rollup (DOR-339, ideation decision
   * 4): mute owns the rollup-dot contribution too, so a muted member's live
   * work never lights a group's collapsed-activity dot.
   */
  mutedPaths?: ReadonlySet<string>;
}

/**
 * Whether ANY of the given agent paths currently has active work (a session
 * that is streaming or awaiting approval), excluding any path in
 * `opts.mutedPaths`.
 *
 * Uses a single aggregated subscription to the global session-list store,
 * folded through the same {@link foldLiveKindsByPath} helper
 * `useAgentAttentionMap` uses — the work set is matched by cwd (`statusCwds`),
 * the same signal that lights up a collapsed agent row in
 * {@link useAgentHottestStatus}.
 *
 * @param paths - Member agent project paths to roll up.
 * @param opts - Muted-path exclusion.
 */
export function useAgentsAggregateStatus(
  paths: string[],
  opts: UseAgentsAggregateStatusOptions = {}
): boolean {
  // Newline-joined keys keep the selector stable by value across renders that
  // pass a fresh array/Set with the same contents (project paths never
  // contain \n), so the store subscription does not churn per-member.
  const key = paths.join('\n');
  const mutedKey = opts.mutedPaths ? [...opts.mutedPaths].sort().join('\n') : '';

  return useSessionListStore(
    useCallback(
      (s) => {
        if (key.length === 0) return false;
        const muted = mutedKey.length === 0 ? null : new Set(mutedKey.split('\n'));
        const pathSet = new Set(key.split('\n').filter((p) => !muted?.has(p)));
        if (pathSet.size === 0) return false;
        const folded = foldLiveKindsByPath(s.statusCwds, s.statuses, pathSet);
        for (const kinds of folded.values()) {
          if (kinds.includes('streaming') || kinds.includes('pendingApproval')) return true;
        }
        return false;
      },
      [key, mutedKey]
    )
  );
}
