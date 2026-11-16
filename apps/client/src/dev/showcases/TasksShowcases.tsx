import { useState, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { TaskTemplateCard, TasksPanel } from '@/layers/features/tasks';
import { TASKS_KEY } from '@/layers/entities/tasks';
import { configKeys } from '@/layers/entities/config';
import type { TaskTemplate } from '@dorkos/shared/types';
import type { Task } from '@dorkos/shared/types';

const RUNNING_SCHEDULE: Task = {
  id: 'sched-health-check',
  name: 'Health Check',
  displayName: null,
  description: null,
  prompt: 'Check the status of all agents and report any issues.',
  cron: '0 8 * * 1',
  timezone: 'UTC',
  defaultCron: '0 8 * * 1',
  defaultTimezone: 'UTC',
  timingOverridden: false,
  packageOwned: null,
  approvalChanges: [],
  agentId: null,
  enabled: true,
  sticky: false,
  maxRuntime: null,
  permissionMode: 'default',
  runtime: null,
  model: null,
  effort: null,
  account: null,
  status: 'active',
  approvedAt: '2026-08-01T07:55:00.000Z',
  approvedBy: { kind: 'person', userId: null, name: 'Dorian' },
  approvedVia: 'created',
  filePath: '',
  createdAt: '2026-08-01T08:00:00.000Z',
  updatedAt: '2026-08-01T08:00:00.000Z',
  reason: null,
  proposedBySessionId: null,
  proposedByAgentPath: null,
  proposedByName: null,
  origin: null,
  reasonSource: null,
  nextRun: '2026-09-08T08:00:00.000Z',
  nextRuns: [],
};

const PAUSED_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-daily-summary',
  name: 'Daily Summary',
  prompt: 'Summarize agent activity, completed tasks, and any errors from the last 24 hours.',
  cron: '0 18 * * *',
  timezone: 'America/New_York',
  enabled: false,
  status: 'paused',
  nextRun: null,
};

/**
 * A schedule that came with an installed package, running on the person's own
 * timing instead of the package's (DOR-2302): the row marks it and, expanded,
 * offers to put the package's timing back.
 */
const RETIMED_PACKAGE_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-flow-drain',
  name: 'flow-drain',
  prompt: 'Claim the top-ranked eligible issue and carry it to its review gate.',
  cron: '30 7 * * 1-5',
  timezone: 'Europe/Berlin',
  defaultCron: '0 * * * *',
  defaultTimezone: 'UTC',
  timingOverridden: true,
  packageOwned: null,
  approvalChanges: [],
  filePath: '~/.dork/plugins/flow/skills/flow-drain/SKILL.md',
  nextRun: '2026-09-08T05:30:00.000Z',
};

/**
 * An agent's proposal parked while switched off: approving keeps it off, so the
 * row offers "Approve" first and "Approve and turn on" beside it (DOR-3309).
 */
const OFF_PROPOSAL_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-weekly-digest',
  name: 'Weekly Digest',
  prompt: 'Write a short digest of the week and post it to #team.',
  cron: '0 17 * * 5',
  enabled: false,
  status: 'pending_approval',
  nextRun: null,
};

/**
 * A task that stayed off when its file started saying on: the row says so, and
 * its own switch is how a person turns it on (DOR-3309).
 */
const FILE_SAYS_ON_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-nightly-sweep',
  name: 'Nightly Sweep',
  prompt: 'Sweep stale branches and report what was removed.',
  cron: '0 2 * * *',
  enabled: false,
  offersTurnOn: true,
  filePath: '~/project/.agents/skills/nightly-sweep/SKILL.md',
  nextRun: null,
};

/**
 * Build an isolated, pre-seeded `QueryClient` for a `TasksPanel` demo.
 *
 * `TasksPanel` reads exclusively from hooks (feature gate, the task list, mesh
 * agents) with no prop overrides, so an isolated client is the only way to
 * show it with fixture data — the pattern `MarketplaceShowcases.tsx` and
 * `SidebarShowcases.tsx` already use for the same reason.
 *
 * @param tasksEnabled - Whether the Tasks feature flag is on.
 * @param tasks - The schedules `useTasks` should resolve with, when enabled.
 */
function makeTasksQueryClient(tasksEnabled: boolean, tasks: Task[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnWindowFocus: false } },
  });
  qc.setQueryData(configKeys.current(), { tasks: { enabled: tasksEnabled } });
  if (tasksEnabled) qc.setQueryData(TASKS_KEY, tasks);
  return qc;
}

/** The next 08:30 UTC from now, so the demo's next run is always ahead. */
function nextUtcHalfPastEight(): string {
  const next = new Date();
  next.setUTCHours(8, 30, 0, 0);
  if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** The next 11:30 PM in Chicago (05:30 UTC in November): "today" until then. */
function nextChicagoHalfPastEleven(): string {
  const next = new Date();
  next.setUTCHours(5, 30, 0, 0);
  if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString();
}

/** The next weekday 9:00 AM in Chicago (15:00 UTC in November), from now. */
function nextWeekdayNineChicago(): string {
  const next = new Date();
  next.setUTCHours(15, 0, 0, 0);
  do {
    if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
    while (next.getUTCDay() === 0 || next.getUTCDay() === 6) next.setUTCDate(next.getUTCDate() + 1);
  } while (next.getTime() <= Date.now());
  return next.toISOString();
}

/** A schedule set in UTC that lands overnight for a reader in Chicago (DOR-4120). */
const UTC_OVERNIGHT_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-inbox-sweep',
  name: 'Morning inbox sweep',
  cron: '30 8 * * *',
  timezone: 'UTC',
  defaultCron: '30 8 * * *',
  defaultTimezone: 'UTC',
  nextRun: nextUtcHalfPastEight(),
};

/** A schedule already in the reader's zone: one line, their time, no offer. */
const LOCAL_WEEKDAY_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-pr-labels',
  name: 'Label new pull requests',
  cron: '0 9 * * 1-5',
  timezone: 'America/Chicago',
  defaultCron: '0 9 * * 1-5',
  defaultTimezone: 'America/Chicago',
  nextRun: nextWeekdayNineChicago(),
};

/** A local schedule whose next run is later today for a reader in Chicago. */
const LOCAL_TONIGHT_SCHEDULE: Task = {
  ...RUNNING_SCHEDULE,
  id: 'sched-day-wrap',
  name: 'Write the day’s wrap-up',
  cron: '30 23 * * *',
  timezone: 'America/Chicago',
  defaultCron: '30 23 * * *',
  defaultTimezone: 'America/Chicago',
  nextRun: nextChicagoHalfPastEleven(),
};

/** One list per state, so each can be looked at (and shot) on its own. */
const YOUR_TIME_STATES: { shot: string; label: string; tasks: Task[] }[] = [
  { shot: 'tz-today', label: 'Next run later today', tasks: [LOCAL_TONIGHT_SCHEDULE] },
  {
    shot: 'tz-tomorrow',
    label: 'Next run tomorrow, or on a weekday name within the week',
    tasks: [LOCAL_WEEKDAY_SCHEDULE],
  },
  {
    shot: 'tz-overnight',
    label: 'Set in UTC, overnight for a reader in Chicago: the offer',
    tasks: [UTC_OVERNIGHT_SCHEDULE],
  },
  { shot: 'tz-empty', label: 'No schedules yet', tasks: [] },
];

/** Rows read in the viewer's own time, with the wrong-zone offer (DOR-4120). */
function TasksYourTimeShowcase() {
  const clients = useMemo(
    () => YOUR_TIME_STATES.map((state) => makeTasksQueryClient(true, state.tasks)),
    []
  );
  return (
    <PlaygroundSection
      title="Schedules in your time"
      description="Rows read in the viewer's own time zone, 12-hour, with no seconds. A schedule set in another zone that runs overnight for the viewer offers to keep its clock time in theirs."
    >
      {YOUR_TIME_STATES.map((state, index) => (
        <div key={state.shot}>
          <ShowcaseLabel>{state.label}</ShowcaseLabel>
          <ShowcaseDemo>
            <QueryClientProvider client={clients[index]!}>
              <div className="bg-background max-w-2xl rounded-lg border" data-shot={state.shot}>
                <TasksPanel />
              </div>
            </QueryClientProvider>
          </ShowcaseDemo>
        </div>
      ))}
    </PlaygroundSection>
  );
}

/** `TasksPanel` in its disabled, empty, and populated states, each its own isolated client. */
function TasksPanelShowcase() {
  const disabledClient = useMemo(() => makeTasksQueryClient(false, []), []);
  const emptyClient = useMemo(() => makeTasksQueryClient(true, []), []);
  const populatedClient = useMemo(
    () => makeTasksQueryClient(true, [RUNNING_SCHEDULE, RETIMED_PACKAGE_SCHEDULE, PAUSED_SCHEDULE]),
    []
  );
  const switchOffersClient = useMemo(
    () => makeTasksQueryClient(true, [OFF_PROPOSAL_SCHEDULE, FILE_SAYS_ON_SCHEDULE]),
    []
  );

  return (
    <PlaygroundSection
      title="TasksPanel"
      description="The composed schedule list every route reaches through the Tasks dialog — disabled, empty, and populated with a running schedule, a package's schedule on the person's own timing, and a paused schedule."
    >
      <ShowcaseLabel>Feature disabled</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={disabledClient}>
          <div className="bg-background h-64 max-w-2xl overflow-hidden rounded-lg border">
            <TasksPanel />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>No schedules yet</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={emptyClient}>
          <div className="bg-background h-64 max-w-2xl overflow-hidden rounded-lg border">
            <TasksPanel />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>Running, retimed and paused schedules</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={populatedClient}>
          <div className="bg-background h-96 max-w-2xl overflow-hidden rounded-lg border">
            <TasksPanel />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>

      <ShowcaseLabel>
        Switched off: a proposal that approves without turning on, and a file that says on
      </ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={switchOffersClient}>
          <div
            data-testid="tasks-switch-offers"
            className="bg-background h-64 max-w-2xl overflow-hidden rounded-lg border"
          >
            <TasksPanel />
          </div>
        </QueryClientProvider>
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}

const HEALTH_CHECK: TaskTemplate = {
  id: 'health-check',
  name: 'Health Check',
  description: 'Run a health check across all registered agents every Monday at 8am.',
  prompt: 'Check the status of all agents and report any issues.',
  cron: '0 8 * * 1',
  timezone: 'UTC',
};

const DAILY_SUMMARY: TaskTemplate = {
  id: 'daily-summary',
  name: 'Daily Summary',
  description: 'Generate a summary of all agent activity from the past 24 hours.',
  prompt: 'Summarize agent activity, completed tasks, and any errors from the last 24 hours.',
  cron: '0 18 * * *',
  timezone: 'America/New_York',
};

/** Tasks feature component showcases: TaskTemplateCard in toggle and selectable variants. */
export function TasksShowcases() {
  const [toggleChecked, setToggleChecked] = useState(true);
  const [selectedId, setSelectedId] = useState<string>('health-check');

  return (
    <>
      <PlaygroundSection
        title="TaskTemplateCard"
        description="Schedule preset card with toggle and selectable variants."
      >
        <ShowcaseLabel>Toggle variant</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-sm">
            <TaskTemplateCard
              preset={HEALTH_CHECK}
              variant="toggle"
              checked={toggleChecked}
              onCheckedChange={setToggleChecked}
            />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Selectable variant</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="grid gap-4 sm:grid-cols-2">
            <TaskTemplateCard
              preset={HEALTH_CHECK}
              variant="selectable"
              selected={selectedId === 'health-check'}
              onSelect={() => setSelectedId('health-check')}
            />
            <TaskTemplateCard
              preset={DAILY_SUMMARY}
              variant="selectable"
              selected={selectedId === 'daily-summary'}
              onSelect={() => setSelectedId('daily-summary')}
            />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <TasksPanelShowcase />
      <TasksYourTimeShowcase />
    </>
  );
}
