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
import { borderKindFromLifecycle } from './use-session-border-state';

/**
 * Whether ANY of the given agent paths currently has active work (a session
 * that is streaming or awaiting approval).
 *
 * Uses a single aggregated subscription to the global session-list store; the
 * work set is matched by cwd (`statusCwds`), the same signal that lights up a
 * collapsed agent row in {@link useAgentHottestStatus}.
 *
 * @param paths - Member agent project paths to roll up.
 */
export function useAgentsAggregateStatus(paths: string[]): boolean {
  // A newline-joined key keeps the selector stable by value across renders that
  // pass a fresh array with the same contents (project paths never contain \n),
  // so the store subscription does not churn per-member.
  const key = paths.join('\n');

  return useSessionListStore(
    useCallback(
      (s) => {
        if (key.length === 0) return false;
        const pathSet = new Set(key.split('\n'));
        for (const [id, cwd] of Object.entries(s.statusCwds)) {
          if (!pathSet.has(cwd)) continue;
          const kind = borderKindFromLifecycle(s.statuses[id]?.lifecycle);
          if (kind === 'streaming' || kind === 'pendingApproval') return true;
        }
        return false;
      },
      [key]
    )
  );
}
