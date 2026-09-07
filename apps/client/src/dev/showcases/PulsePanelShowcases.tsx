import { useEffect, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { PulsePanel } from '@/layers/widgets/pulse';
import { DASHBOARD_ACTIVITY_QUERY_KEY } from '@/layers/features/dashboard-activity';
import {
  RECENT_SESSIONS_WINDOW,
  sessionKeys,
  useSessionListStore,
} from '@/layers/entities/session';
import { TASKS_KEY } from '@/layers/entities/tasks';
import { configKeys } from '@/layers/entities/config';
import type { ActivityItem, ListActivityResponse } from '@dorkos/shared/activity-schemas';
import type { RecentSessionsResponse, Session, Task } from '@dorkos/shared/types';
import type { SessionStatus } from '@dorkos/shared/session-stream';

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
 * The session id the wedged-session demo seeds, and the only key this file
 * ever writes into the global session-list store.
 *
 * A uuid nothing else in the app or the playground uses, which is what makes
 * the store write safe (see {@link useWedgedSession}): every reader of
 * `statuses` joins it to a session list by id, so a status for an id no other
 * fixture mentions contributes to nobody else's answer.
 */
const WEDGED_SESSION_ID = '00000000-0000-0000-0000-0000000019b1';

/** A session the runtime stopped with an error — the `error` attention signal. */
const WEDGED_SESSION: Session = {
  id: WEDGED_SESSION_ID,
  title: 'Migrate the billing worker off the old queue',
  createdAt: new Date(Date.now() - 40 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 6 * 60_000).toISOString(),
  permissionMode: 'default',
  runtime: 'claude-code',
  cwd: '/Users/you/code/billing-worker',
};

/**
 * The status that makes it a signal.
 *
 * `deriveAttentionSignals` raises the `error` signal off this one field, which
 * is why it is the lifecycle seeded.
 *
 * **Two hooks scan `statuses` globally rather than joining it to a session list,
 * and `error` is one of the two things they scan for** — so the value here is
 * not what makes the seed safe (see {@link useWedgedSession} for what does).
 * `use-tour-occasions.ts` asks whether ANY status is `streaming`;
 * `use-dorkbot-seed.ts` collects the ids of every status that is `error`.
 * Neither is reachable from the playground: the tour hook wants a `streaming`
 * this never writes, and the DorkBot seed is mounted by `ChatPanel`
 * (`widgets/session/ui/ChatPanel.tsx`), a surface no `/dev/*` page renders.
 */
const WEDGED_STATUS: SessionStatus = {
  contextUsage: null,
  cost: null,
  usage: null,
  cacheStats: null,
  model: null,
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'error',
  lastError: null,
};

/** A schedule an agent proposed and parked — the `schedule-approval` signal. */
const PARKED_SCHEDULE: Task = {
  id: 'sched-nightly-triage',
  name: 'Nightly triage',
  displayName: 'Nightly triage',
  description: null,
  prompt: 'Sweep yesterday’s failed runs and open an issue for each distinct cause.',
  cron: '0 2 * * *',
  timezone: 'UTC',
  agentId: null,
  enabled: false,
  sticky: false,
  maxRuntime: null,
  permissionMode: 'default',
  runtime: null,
  model: null,
  effort: null,
  status: 'pending_approval',
  filePath: '',
  createdAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  updatedAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString(),
  reason: 'It found the same three failures four nights running.',
  proposedBySessionId: null,
  proposedByAgentPath: null,
  proposedByName: 'code-reviewer',
  origin: null,
  reasonSource: null,
  nextRun: null,
  nextRuns: [],
};

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
 * Everything the Needs Attention half reads, in one isolated client.
 *
 * `useAttentionRows` draws two blocking groups and one quiet one. Both blocking
 * groups are seeded here: the parked schedule comes from `['tasks']` behind the
 * Tasks config flag (exactly as `TasksShowcases` seeds it), and the wedged
 * session comes from the recent-sessions query — the half of the `error` signal
 * that is query-shaped. The other half of that signal is the lifecycle, which
 * lives in a Zustand store no `QueryClientProvider` can reach; see
 * {@link useWedgedSession}.
 */
function makeAttentionQueryClient(): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  qc.setQueryData(configKeys.current(), { tasks: { enabled: true } });
  qc.setQueryData(TASKS_KEY, [PARKED_SCHEDULE]);
  const recent: RecentSessionsResponse = {
    sessions: [WEDGED_SESSION],
    agentActivity: {},
  };
  qc.setQueryData(sessionKeys.recent(RECENT_SESSIONS_WINDOW), recent);
  qc.setQueryData(DASHBOARD_ACTIVITY_QUERY_KEY, {
    items: RECENT_ACTIVITY,
    nextCursor: null,
  } satisfies ListActivityResponse);
  return qc;
}

/**
 * Seed one wedged session's lifecycle into the global session-list store while
 * this demo is mounted, and put the store back exactly as it was on the way
 * out.
 *
 * **This is the one thing on the page that a `QueryClientProvider` cannot
 * isolate**, and it is why the populated Needs Attention demo did not exist
 * until DOR-1816. `useAttentionSignals` reads a session's lifecycle from
 * `useSessionListStore`, which is a module-level Zustand store shared by every
 * section mounted beside this one.
 *
 * Three things keep the write from reaching them, and all three are needed:
 *
 * 1. **The id is unique to this file**, and this is the load-bearing one. Every
 *    reader that joins `statuses` to a session list does it BY SESSION ID
 *    against a list it fetched itself (`use-attention-signals`,
 *    `use-live-sessions`, `use-presence-rows`, `palette-recent`), so a status
 *    keyed to an id no other fixture mentions joins to nothing and changes
 *    nobody's answer.
 * 2. **The two hooks that scan `statuses` WITHOUT joining are both unreachable
 *    from here.** They are the exception rule 1 does not cover, and the
 *    lifecycle value is not what saves us from them — `use-dorkbot-seed.ts`
 *    scans for exactly the `error` this seeds. It is mounted by `ChatPanel`,
 *    which no `/dev/*` page renders; the other, `use-tour-occasions.ts`, scans
 *    for `streaming`, which this never writes. See {@link WEDGED_STATUS}.
 * 3. **The previous value is restored on unmount**, whatever it was, so
 *    navigating away from `/dev/features` leaves the store as the app's own
 *    stream left it. Pinned by `dev/__tests__/every-showcase-mounts.test.tsx`,
 *    which asserts the store is seeded while the page is up and byte-identical
 *    to its prior state once it comes down — mutate either branch of the
 *    cleanup below and that case fails.
 */
function useWedgedSession(): void {
  useEffect(() => {
    // **Both maps, because `setSessionStatus` writes both.** Restoring the
    // status while leaving our own `cwd` behind would put this file's fake
    // directory against somebody else's session — unreachable today (nothing
    // else holds this id) and wrong the moment it is not.
    const store = useSessionListStore.getState();
    const beforeStatus = store.statuses[WEDGED_SESSION_ID];
    const beforeCwd = store.statusCwds[WEDGED_SESSION_ID];
    store.setSessionStatus(WEDGED_SESSION_ID, WEDGED_STATUS, WEDGED_SESSION.cwd);
    return () => {
      const current = useSessionListStore.getState();
      // `removeSession` clears every map this id could have reached, which is
      // the honest undo for a status that was not there before.
      if (beforeStatus === undefined) current.removeSession(WEDGED_SESSION_ID);
      else current.setSessionStatus(WEDGED_SESSION_ID, beforeStatus, beforeCwd);
    };
  }, []);
}

/**
 * `PulsePanel` with its Needs Attention half populated.
 *
 * Split into its own component so the store write in {@link useWedgedSession}
 * lives and dies with THIS demo rather than with the whole section — a hook in
 * `PulsePanelShowcase` would hold the seeded lifecycle for as long as the page
 * is open, including while a reader is looking at the all-clear demo above it.
 */
function PopulatedAttentionDemo() {
  const client = useMemo(() => makeAttentionQueryClient(), []);
  useWedgedSession();

  return (
    <QueryClientProvider client={client}>
      <div className="bg-background h-80 max-w-sm overflow-hidden rounded-lg border">
        <PulsePanel />
      </div>
    </QueryClientProvider>
  );
}

/**
 * `PulsePanel` in its all-clear fallback state, with its Activity half
 * populated, and with both halves populated at once.
 *
 * The real component. Unseeded, every hook it reads through — attention
 * signals, pending approvals and schedules, recent sessions, dashboard
 * activity — answers empty against the playground's ambient transport, which
 * is exactly the state each section falls back to when nothing needs the
 * operator.
 *
 * The third demo is the one this file could not draw until DOR-1816, and the
 * reason is worth keeping: `useAttentionSignals` reads a session's lifecycle
 * out of a global Zustand store that no `QueryClientProvider` can scope. It is
 * seeded now rather than avoided — see {@link useWedgedSession} for the three
 * things that keep that write from reaching the sections mounted beside it.
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

      <ShowcaseLabel>Activity populated — Needs Attention still all-clear</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={populatedActivityClient}>
          <div className="bg-background h-80 max-w-sm overflow-hidden rounded-lg border">
            <PulsePanel />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Needs Attention populated — a schedule an agent parked, and a session that stopped with an
        error
      </ShowcaseLabel>
      <ShowcaseDemo>
        <PopulatedAttentionDemo />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
