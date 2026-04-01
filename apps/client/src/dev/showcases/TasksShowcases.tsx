import { useState } from 'react';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { TaskTemplateCard } from '@/layers/features/tasks';
import type { TaskTemplate } from '@dorkos/shared/types';

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
    </>
  );
}
