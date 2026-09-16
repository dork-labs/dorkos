/**
 * What this machine has spent, from the runtimes' own reporting.
 *
 * The local spend view is the honest counterweight to the cloud figures: it is
 * the cost the runtimes themselves reported for the sessions this app is
 * holding, and it is complete only for the runtimes that report cost at all.
 * `supportsCostTracking` is the whole of that distinction — a runtime that
 * declares `false` contributes nothing and is NAMED, because a total that
 * silently omitted a runtime would read as "you spent this much" when it means
 * "you spent at least this much".
 *
 * Nothing here talks to the cloud, so it renders on an install with no account.
 *
 * @module features/cloud-plan/model/use-local-spend
 */
import { useMemo } from 'react';
import { useSessionChatStore } from '@/layers/entities/session';
import { useRuntimeCapabilities } from '@/layers/entities/runtime';

/** What the local spend view renders. */
export interface LocalSpend {
  /** Cost the runtimes reported, summed over the sessions this app is holding. */
  totalUsd: number;
  /** How many sessions contributed a figure. */
  sessionCount: number;
  /**
   * Runtime types this server offers that report no cost at all, so the total
   * above can say what it is missing instead of implying it is everything.
   */
  runtimesWithoutCost: string[];
  /** Whether there is anything worth rendering. */
  hasAnything: boolean;
}

/**
 * Sum the per-session cost the runtimes reported, and name what is missing.
 *
 * Reads the session store this app already keeps rather than asking the server
 * for a total: no runtime persists per-turn cost, so a server-side lifetime
 * figure does not exist to be read (see the follow-ups on DOR-2027).
 */
export function useLocalSpend(): LocalSpend {
  const sessions = useSessionChatStore((state) => state.sessions);
  const { data: capabilities } = useRuntimeCapabilities();

  return useMemo(() => {
    let totalUsd = 0;
    let sessionCount = 0;
    for (const session of Object.values(sessions)) {
      const cost = session.sessionStatus?.costUsd;
      if (typeof cost === 'number' && cost > 0) {
        totalUsd += cost;
        sessionCount += 1;
      }
    }
    const runtimesWithoutCost = Object.entries(capabilities?.capabilities ?? {})
      .filter(([, caps]) => caps.supportsCostTracking === false)
      .map(([runtime]) => runtime)
      .sort();
    return {
      totalUsd,
      sessionCount,
      runtimesWithoutCost,
      hasAnything: sessionCount > 0 || runtimesWithoutCost.length > 0,
    };
  }, [sessions, capabilities]);
}
