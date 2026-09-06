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
  agentId: null,
  enabled: true,
  sticky: false,
  maxRuntime: null,
  permissionMode: 'default',
  runtime: null,
  model: null,
  effort: null,
  status: 'active',
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

/** `TasksPanel` in its disabled, empty, and populated states, each its own isolated client. */
function TasksPanelShowcase() {
  const disabledClient = useMemo(() => makeTasksQueryClient(false, []), []);
  const emptyClient = useMemo(() => makeTasksQueryClient(true, []), []);
  const populatedClient = useMemo(
    () => makeTasksQueryClient(true, [RUNNING_SCHEDULE, PAUSED_SCHEDULE]),
    []
  );

  return (
    <PlaygroundSection
      title="TasksPanel"
      description="The composed schedule list every route reaches through the Tasks dialog — disabled, empty, and populated with a running and a paused schedule."
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

      <ShowcaseLabel>Running and paused schedules</ShowcaseLabel>
      <ShowcaseDemo>
        <QueryClientProvider client={populatedClient}>
          <div className="bg-background h-96 max-w-2xl overflow-hidden rounded-lg border">
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
    </>
  );
}
