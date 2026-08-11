import { useState } from 'react';
import { BackgroundTaskBar } from '@/layers/features/chat/ui/tasks/BackgroundTaskBar';
import { TaskDotSection } from '@/layers/features/chat/ui/tasks/TaskDotSection';
import { TaskDetailPanel } from '@/layers/features/chat/ui/tasks/TaskDetailPanel';
import { InlineKillButton } from '@/layers/features/chat/ui/tasks/InlineKillButton';
import { TASK_COLORS } from '@/layers/features/chat/model/use-background-tasks';
import type { VisibleBackgroundTask } from '@/layers/features/chat/model/use-background-tasks';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';

// ---------------------------------------------------------------------------
// Mock VisibleBackgroundTask data for showcases
// ---------------------------------------------------------------------------

const MOCK_VISIBLE_TASKS: Record<string, VisibleBackgroundTask> = {
  agent_running: {
    taskId: 'vis-agent-1',
    taskType: 'agent',
    status: 'running',
    color: TASK_COLORS[0],
    startedAt: Date.now() - 23000,
    description: 'Exploring codebase for auth patterns',
    toolUses: 7,
    lastToolName: 'Grep',
    durationMs: 23000,
  },
  agent_running_2: {
    taskId: 'vis-agent-2',
    taskType: 'agent',
    status: 'running',
    color: TASK_COLORS[1],
    startedAt: Date.now() - 45000,
    description: 'Research JWT best practices',
    toolUses: 12,
    lastToolName: 'WebSearch',
    durationMs: 45000,
  },
  bash_dev_server: {
    taskId: 'vis-bash-1',
    taskType: 'bash',
    status: 'running',
    color: TASK_COLORS[2],
    startedAt: Date.now() - 120000,
    command: 'npm run dev',
    durationMs: 120000,
  },
  bash_build: {
    taskId: 'vis-bash-2',
    taskType: 'bash',
    status: 'running',
    color: TASK_COLORS[3],
    startedAt: Date.now() - 15000,
    command: 'pnpm build --filter=@dorkos/client',
    durationMs: 15000,
  },
  bash_complete: {
    taskId: 'vis-bash-3',
    taskType: 'bash',
    status: 'complete',
    color: TASK_COLORS[4],
    startedAt: Date.now() - 45000,
    command: 'pnpm test -- --run',
    durationMs: 45000,
  },
  agent_stopped: {
    taskId: 'vis-agent-3',
    taskType: 'agent',
    status: 'stopped',
    color: TASK_COLORS[0],
    startedAt: Date.now() - 30000,
    description: 'Deep analysis of auth patterns',
    toolUses: 15,
    durationMs: 30000,
    summary: 'Stopped by user.',
  },
  // Beside `agent_stopped` on purpose — the two are one comparison: the tick for
  // a stop somebody observed, the dash for one DorkOS lost sight of (DOR-1108).
  agent_untracked: {
    taskId: 'vis-agent-4',
    taskType: 'agent',
    status: 'untracked',
    color: TASK_COLORS[3],
    startedAt: Date.now() - 240000,
    description: 'Run the dev server in the background',
    durationMs: 240000,
  },
};

/**
 * Background-task component showcases: BackgroundTaskBar, TaskDotSection,
 * TaskDetailPanel, InlineKillButton. Rendered by `ToolShowcases` on the chat
 * page — background tasks are the tool stream's other half.
 */
export function BackgroundTaskShowcases() {
  const [stopLog, setStopLog] = useState<string[]>([]);
  const logStop = (taskId: string) =>
    setStopLog((prev) => [...prev, `Stopped: ${taskId} at ${new Date().toLocaleTimeString()}`]);

  const allTasks = Object.values(MOCK_VISIBLE_TASKS);
  const agentTasks = allTasks.filter((t) => t.taskType === 'agent' && t.status === 'running');
  const bashTasks = allTasks.filter((t) => t.taskType === 'bash' && t.status === 'running');
  const mixedRunning = [...agentTasks.slice(0, 2), ...bashTasks.slice(0, 2)];

  return (
    <>
      <PlaygroundSection
        title="BackgroundTaskBar"
        description="Unified indicator bar for background agents and bash commands. Expandable to show detail rows with kill buttons."
      >
        <ShowcaseLabel>Mixed tasks (2 agents + 2 bash)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-md">
            <BackgroundTaskBar tasks={mixedRunning} onStopTask={logStop} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Agents only (2 running)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-md">
            <BackgroundTaskBar tasks={agentTasks.slice(0, 2)} onStopTask={logStop} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Bash only (2 running)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-md">
            <BackgroundTaskBar tasks={bashTasks.slice(0, 2)} onStopTask={logStop} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Empty (renders nothing)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="max-w-md">
            <BackgroundTaskBar tasks={[]} onStopTask={logStop} />
            <p className="text-muted-foreground mt-2 text-xs">
              (Nothing renders above — bar is hidden when no tasks are active)
            </p>
          </div>
        </ShowcaseDemo>

        {stopLog.length > 0 && (
          <div className="mt-4 rounded-md border p-3">
            <ShowcaseLabel>Stop event log</ShowcaseLabel>
            <div className="text-muted-foreground space-y-1 font-mono text-xs">
              {stopLog.map((entry, i) => (
                <div key={i}>{entry}</div>
              ))}
            </div>
          </div>
        )}
      </PlaygroundSection>

      <PlaygroundSection
        title="TaskDotSection"
        description="Pulsing colored dots for background bash tasks. Renders inside the unified bar."
      >
        <ShowcaseLabel>2 running bash tasks</ShowcaseLabel>
        <ShowcaseDemo>
          <TaskDotSection bashTasks={bashTasks} />
        </ShowcaseDemo>

        <ShowcaseLabel>Single bash task</ShowcaseLabel>
        <ShowcaseDemo>
          <TaskDotSection bashTasks={bashTasks.slice(0, 1)} />
        </ShowcaseDemo>

        <ShowcaseLabel>Empty (renders nothing)</ShowcaseLabel>
        <ShowcaseDemo>
          <TaskDotSection bashTasks={[]} />
          <p className="text-muted-foreground mt-2 text-xs">(Nothing renders above)</p>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="TaskDetailPanel"
        description="Expandable chip list showing all background tasks with kill buttons and status."
      >
        <ShowcaseLabel>Mixed tasks (agent + bash, every status)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="bg-card max-w-md rounded-lg border">
            <TaskDetailPanel tasks={allTasks} onStopTask={logStop} />
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Running only</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="bg-card max-w-md rounded-lg border">
            <TaskDetailPanel tasks={mixedRunning} onStopTask={logStop} />
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="InlineKillButton"
        description="Kill button with instant action for bash and 'Stop?' confirmation for agents."
      >
        <ShowcaseLabel>Bash (instant kill on click)</ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex items-center gap-4">
            <InlineKillButton taskType="bash" onConfirm={() => logStop('bash-demo')} />
            <span className="text-muted-foreground text-xs">Click the × — fires immediately</span>
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>
          Agent (click → &quot;Stop?&quot; → click to confirm, 3s auto-dismiss)
        </ShowcaseLabel>
        <ShowcaseDemo>
          <div className="flex items-center gap-4">
            <InlineKillButton taskType="agent" onConfirm={() => logStop('agent-demo')} />
            <span className="text-muted-foreground text-xs">
              Click × → morphs to &quot;Stop?&quot; → click again to confirm or wait 3s
            </span>
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
