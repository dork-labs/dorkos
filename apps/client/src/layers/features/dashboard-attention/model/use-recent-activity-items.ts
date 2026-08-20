/**
 * What recently went wrong and is still wrong — failed runs, undeliverable
 * Relay messages, agents nobody can reach.
 *
 * **This is not the attention engine.** It used to be: a second derivation
 * called `useAttentionItems` sat here computing "needs attention" from its own
 * heuristics, while `entities/attention` computed it from different ones for
 * the sidebar — two engines, two answers, one operator (DOR-1381). The
 * derivation is gone; `entities/attention` is the only one left. What survives
 * here is the three ROWS that were never blockages in the first place: nothing
 * is waiting on you, something merely happened. They keep their place on the
 * home surface until the Inbox absorbs them as Activity items (DOR-1384).
 *
 * The fourth row this file used to raise — "Session idle for N minutes" — is
 * gone entirely. A session going quiet is not a thing that needs a person, and
 * saying so every minute for a day taught people to read past the whole group.
 *
 * @module features/dashboard-attention/model/use-recent-activity-items
 */
import { useMemo } from 'react';
import { useTaskRuns } from '@/layers/entities/tasks';
import { useAggregatedDeadLetters } from '@/layers/entities/relay';
import { useMeshStatus } from '@/layers/entities/mesh';
import { useNow } from '@/layers/shared/model';
import { useNavigate } from '@tanstack/react-router';
import type { LucideIcon } from 'lucide-react';
import { XCircle, Mail, WifiOff } from 'lucide-react';

/** How far back a failed run is still worth mentioning. */
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Maximum number of rows the group draws. */
const MAX_ITEMS = 8;

/** One thing that went wrong, in the shape the row draws. */
export interface RecentActivityItem {
  /** Stable id, namespaced per source so two sources cannot collide. */
  id: string;
  /** Which of the three this is. */
  type: 'failed-run' | 'dead-letter' | 'offline-agent';
  /** The mark drawn beside it. */
  icon: LucideIcon;
  /** The headline, used by the detail sheets and the playground. */
  title: string;
  /** The one line the row prints. */
  description: string;
  /** When it happened, ISO-8601. Most recent first. */
  timestamp: string;
  /** Where the row's button goes. */
  action: {
    label: string;
    onClick: () => void;
  };
  /** How loudly it draws. */
  severity: 'warning' | 'error';
}

/** The rows plus whether their backing queries are still cold-loading. */
export interface RecentActivityState {
  /** The derived rows, most recent first and capped at {@link MAX_ITEMS}. */
  items: RecentActivityItem[];
  /**
   * True while any backing query is still on its first load (no data yet), so a
   * consumer can withhold an "all clear" until the data that would justify it
   * has actually arrived — otherwise the reassurance flashes before a row pops
   * in. Uses each query's `isLoading` (first-load-in-progress), not raw
   * `isPending`, so a feature-gated/disabled query never wedges this true.
   */
  isLoading: boolean;
}

/**
 * Failed Tasks runs from the last 24 hours, Relay dead letters, and offline
 * Mesh agents — sorted most recent first.
 *
 * Each row keeps the deep link it always had (`/?detail=…&itemId=…`), so a URL
 * somebody pasted still opens the same detail sheet.
 */
export function useRecentActivityItems(): RecentActivityState {
  const { data: failedRuns, isLoading: failedRunsLoading } = useTaskRuns({ status: 'failed' });
  const { data: deadLetters, isLoading: deadLettersLoading } = useAggregatedDeadLetters();
  const { data: meshStatus, isLoading: meshLoading } = useMeshStatus();
  const navigate = useNavigate();
  const now = useNow();

  const isLoading = Boolean(failedRunsLoading || deadLettersLoading || meshLoading);

  const items = useMemo(() => {
    const items: RecentActivityItem[] = [];
    const twentyFourHoursAgo = now - TWENTY_FOUR_HOURS_MS;

    if (failedRuns) {
      for (const run of failedRuns) {
        const runTime = new Date(run.createdAt).getTime();
        if (runTime > twentyFourHoursAgo) {
          items.push({
            id: `failed-${run.id}`,
            type: 'failed-run',
            icon: XCircle,
            title: `Tasks run failed`,
            description: `Tasks run ${run.id.slice(0, 8)} failed`,
            timestamp: run.createdAt,
            action: {
              label: 'View →',
              onClick: () =>
                navigate({
                  to: '/',
                  search: { detail: 'failed-run', itemId: run.id },
                }),
            },
            severity: 'error',
          });
        }
      }
    }

    if (deadLetters) {
      for (const group of deadLetters) {
        if (group.count > 0) {
          items.push({
            id: `dead-letter-${group.source}-${group.reason}`,
            type: 'dead-letter',
            icon: Mail,
            title: `${group.count} undeliverable Relay message${group.count === 1 ? '' : 's'}`,
            description: `Dead letters: ${group.source} — ${group.reason}`,
            timestamp: group.lastSeen,
            action: {
              label: 'View →',
              onClick: () =>
                navigate({
                  to: '/',
                  search: { detail: 'dead-letter', itemId: `${group.source}::${group.reason}` },
                }),
            },
            severity: 'warning',
          });
        }
      }
    }

    if (meshStatus && meshStatus.unreachableCount > 0) {
      const count = meshStatus.unreachableCount;
      items.push({
        id: 'offline-agents',
        type: 'offline-agent',
        icon: WifiOff,
        title: `${count} agent${count > 1 ? 's' : ''} offline`,
        description: `${count} mesh agent${count > 1 ? 's' : ''} unreachable`,
        timestamp: new Date(now).toISOString(),
        action: {
          label: 'View →',
          onClick: () =>
            navigate({
              to: '/',
              search: { detail: 'offline-agent', itemId: 'offline' },
            }),
        },
        severity: 'error',
      });
    }

    items.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

    return items.slice(0, MAX_ITEMS);
  }, [now, failedRuns, deadLetters, meshStatus, navigate]);

  return { items, isLoading };
}
