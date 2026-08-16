/**
 * Tasks — what this agent runs on a schedule, and what those runs did (spec
 * `profile-unification` §1.5, D7).
 *
 * "Tasks", never "Schedule": a schedule is the clock, and what an operator cares
 * about is the work. Presets appear only when there is nothing here yet, which
 * is the one moment they answer a question rather than take up room.
 *
 * @module features/profile/ui/pages/TasksPage
 */
import { useAgentToolStatus } from '@/layers/entities/agent';
import { TasksView } from '@/layers/features/session-list';
import type { ProfilePageContentProps } from './types';

/**
 * This agent's schedules and recent runs.
 *
 * The row that pushes this page is not drawn at all when the server has tasks
 * switched off (`useManagedAgentFacts`), so the only "off" state this page has
 * to answer for is the per-agent one — which `TasksView` already says in its own
 * words, with a door into the Tasks surface beside it.
 */
export function TasksPage({ member }: ProfilePageContentProps) {
  const projectPath = member.agent?.projectPath ?? null;
  const toolStatus = useAgentToolStatus(projectPath);
  const agentId = member.agent?.manifestId ?? null;

  return (
    <div className="min-h-0 flex-1" data-slot="profile-tasks">
      <TasksView toolStatus={toolStatus.tasks} agentId={agentId} />
    </div>
  );
}
