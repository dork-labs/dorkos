/**
 * The fleet-level context rollup — runtime-neutral counts folded from every
 * session in the list, resolving each row via the SAME §6 rule the per-row
 * gauge uses ({@link resolveSessionContextHealth}), so there is exactly one
 * resolution rule and the rollup can never become a divergent percent copy.
 * Shaped after `use-agent-hottest-status`'s fold. Surface-agnostic: the fleet
 * summary bar consumes it today and the staged agents-dashboard tile reuses it
 * later.
 *
 * @module entities/session/model/use-fleet-context-rollup
 */
import { useCallback, useMemo } from 'react';
import { useQueries, type UseQueryResult } from '@tanstack/react-query';
import type { ModelOption } from '@dorkos/shared/types';
import { useTransport } from '@/layers/shared/model';
import { modelsQueryOptions } from './use-models';
import { useSessionListSessions, useSessionListStore } from './session-list-store';
import { resolveSessionContextHealth } from './use-session-context-health';

/**
 * Counts across the fleet's sessions. `known + unknown === total`;
 * `warning + critical` is the "near full" total the summary copy reports.
 */
export interface FleetContextRollup {
  /** Sessions considered (the whole list). */
  total: number;
  /** Sessions with a resolvable reading (live or list). */
  known: number;
  /** Sessions with no reading — fabricate nothing. */
  unknown: number;
  /** Sessions at severity `warning` (≥80%, <95%). */
  warning: number;
  /** Sessions at severity `critical` (≥95%). */
  critical: number;
  /** Sessions carrying `lastAutoCompactAt`, regardless of percent state. */
  autoCompacted: number;
}

/** Runtime → (model value → context window), the O(1) lookup the fold uses. */
type CatalogWindows = Record<string, Record<string, number>>;

/**
 * Fold the whole session list into {@link FleetContextRollup} counts. Fetches
 * each distinct runtime's model catalog once (`useQueries`, deduped by query
 * key with the per-row `useModels`) so a list-only row can resolve its window,
 * reads the retained live readings from the store, and applies the shared §6
 * rule per session. Unknown rows are counted in `unknown` and NEVER folded
 * into a percent bucket.
 */
export function useFleetContextRollup(): FleetContextRollup {
  const sessions = useSessionListSessions();
  const contextReadings = useSessionListStore((s) => s.contextReadings);
  const transport = useTransport();

  const runtimes = useMemo(() => Array.from(new Set(sessions.map((s) => s.runtime))), [sessions]);

  // Combine the per-runtime catalog queries into a plain, structurally-shareable
  // lookup so `useQueries` can dedupe references across renders (a Map return
  // here would defeat structural sharing and spin an infinite re-render loop).
  const combine = useCallback(
    (results: UseQueryResult<ModelOption[]>[]): CatalogWindows => {
      const byRuntime: CatalogWindows = {};
      runtimes.forEach((runtime, i) => {
        const models = results[i]?.data;
        if (!models) return;
        const windows: Record<string, number> = {};
        for (const m of models) {
          if (m.contextWindow != null) windows[m.value] = m.contextWindow;
        }
        byRuntime[runtime] = windows;
      });
      return byRuntime;
    },
    [runtimes]
  );

  const catalogWindows = useQueries({
    queries: runtimes.map((runtime) => modelsQueryOptions(transport, { runtime })),
    combine,
  });

  return useMemo(() => {
    const rollup: FleetContextRollup = {
      total: 0,
      known: 0,
      unknown: 0,
      warning: 0,
      critical: 0,
      autoCompacted: 0,
    };
    for (const session of sessions) {
      rollup.total += 1;
      const window = session.model ? catalogWindows[session.runtime]?.[session.model] : undefined;
      const health = resolveSessionContextHealth(session, {
        reading: contextReadings[session.id] ?? null,
        window,
      });
      if (health.autoCompactedAt) rollup.autoCompacted += 1;
      if (health.status === 'known') {
        rollup.known += 1;
        if (health.severity === 'warning') rollup.warning += 1;
        else if (health.severity === 'critical') rollup.critical += 1;
      } else {
        rollup.unknown += 1;
      }
    }
    return rollup;
  }, [sessions, contextReadings, catalogWindows]);
}
