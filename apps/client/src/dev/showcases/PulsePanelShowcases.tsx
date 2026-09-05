import { useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { PulsePanel } from '@/layers/widgets/pulse';
import { DASHBOARD_ACTIVITY_QUERY_KEY } from '@/layers/features/dashboard-activity';
import type { ActivityItem, ListActivityResponse } from '@dorkos/shared/activity-schemas';

const RECENT_ACTIVITY: ActivityItem[] = [
  {
    id: 'act-1',
    occurredAt: new Date().toISOString(),
    actorType: 'agent',
    actorId: 'code-reviewer',
    actorLabel: 'code-reviewer',
    category: 'relay',
    eventType: 'relay.message.sent',
    resourceType: 'room',
    resourceId: 'room-1',
    resourceLabel: '#engineering',
    summary: 'Posted a review summary in #engineering',
    linkPath: '/channels/room-1',
    metadata: null,
  },
  {
    id: 'act-2',
    occurredAt: new Date(Date.now() - 15 * 60_000).toISOString(),
    actorType: 'tasks',
    actorId: 'sched-health-check',
    actorLabel: 'Health Check',
    category: 'tasks',
    eventType: 'task.run.completed',
    resourceType: 'schedule',
    resourceId: 'sched-health-check',
    resourceLabel: 'Health Check',
    summary: 'Completed the scheduled health check',
    linkPath: null,
    metadata: null,
  },
];

/**
 * Build an isolated, pre-seeded `QueryClient` seeding {@link DASHBOARD_ACTIVITY_QUERY_KEY}.
 *
 * `PulseActivitySection` reads exclusively through `useDashboardActivity`
 * (TanStack Query, no Zustand involved), so seeding this one key populates
 * the Activity half of `PulsePanel` — the isolated-client pattern
 * `TasksShowcases`, `RelayShowcases` and `ConnectionsShowcases` already use.
 *
 * @param items - Activity items the seeded query should resolve with.
 */
function makeActivityQueryClient(items: ActivityItem[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  const response: ListActivityResponse = { items, nextCursor: null };
  qc.setQueryData(DASHBOARD_ACTIVITY_QUERY_KEY, response);
  return qc;
}

/**
 * `PulsePanel` in its all-clear fallback state and with its Activity half
 * populated.
 *
 * The real component. Unseeded, every hook it reads through — attention
 * signals, pending approvals and schedules, recent sessions, dashboard
 * activity — answers empty against the playground's ambient transport, which
 * is exactly the state each section falls back to when nothing needs the
 * operator.
 *
 * The Needs Attention half stays all-clear-only: `useAttentionSignals` joins
 * approvals, parked schedules, recent sessions, live session lifecycle,
 * pending interactions and the mesh roster through a global Zustand
 * session-list store, and mutating that store here would leak into any other
 * section mounted on the same page — left to a future pass rather than
 * risking a misleading or flaky demo. The Activity half has no such blocker:
 * `useDashboardActivity` is TanStack-Query-only, so an isolated seeded client
 * populates it with no cross-section risk.
 */
export function PulsePanelShowcase() {
  const populatedActivityClient = useMemo(() => makeActivityQueryClient(RECENT_ACTIVITY), []);

  return (
    <PlaygroundSection
      title="PulsePanel"
      description="The always-present global spine tab of the right inspector panel — the first tab on every route and the panel's no-selection fallback. Two capped teasers, each collapsing to a calm one-line all-clear rather than vanishing."
    >
      <ShowcaseLabel>All-clear — nothing needs the operator</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="bg-background h-80 max-w-sm overflow-hidden rounded-lg border">
          <PulsePanel />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Activity populated — Needs Attention stays all-clear (see TSDoc for why)
      </ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={populatedActivityClient}>
          <div className="bg-background h-80 max-w-sm overflow-hidden rounded-lg border">
            <PulsePanel />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
