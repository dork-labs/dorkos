/**
 * Schedules — what this agent runs on a timer, and what those runs did (spec
 * `profile-unification` §1.5, D7).
 *
 * The row said "Tasks" until DOR-1490, on the reasoning that a schedule is the
 * clock and the work is what an operator cares about. The rename overrules it
 * for a reason that outranks it: the bare word "task" already names the to-do
 * list a chat turn keeps, and one word cannot mean both. Presets appear only
 * when there is nothing here yet, which is the one moment they answer a
 * question rather than take up room.
 *
 * @module features/profile/ui/pages/TasksPage
 */
import { useTasksEnabled } from '@/layers/entities/tasks';
import { TasksView } from '@/layers/features/session-list';
import type { ProfilePageContentProps } from './types';

/**
 * This agent's schedules and recent runs.
 *
 * The row that pushes this page is not drawn at all when the server has tasks
 * switched off (`useManagedAgentFacts`). A Blocked Tasks & schedules permission
 * is not an "off" here: it stops the AGENT changing schedules, and the ones a
 * person made still run, so they are still listed.
 */
export function TasksPage({ member }: ProfilePageContentProps) {
  const tasksEnabled = useTasksEnabled();
  const agentId = member.agent?.manifestId ?? null;

  return (
    <div className="min-h-0 flex-1" data-slot="profile-tasks">
      <TasksView available={tasksEnabled} agentId={agentId} />
    </div>
  );
}
