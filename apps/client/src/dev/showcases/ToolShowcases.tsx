import { useState } from 'react';
import { ToolCallCard } from '@/layers/features/chat/ui/ToolCallCard';
import { ToolApproval } from '@/layers/features/chat/ui/ToolApproval';
import { SubagentBlock } from '@/layers/features/chat/ui/SubagentBlock';
import { ErrorMessageBlock } from '@/layers/features/chat/ui/ErrorMessageBlock';
import { ThinkingBlock } from '@/layers/features/chat/ui/ThinkingBlock';
import { CollapsibleRun } from '@/layers/features/chat/ui/message/AssistantMessageContent';
import { BackgroundTaskBar } from '@/layers/features/chat/ui/BackgroundTaskBar';
import { TaskDotSection } from '@/layers/features/chat/ui/TaskDotSection';
import { TaskDetailPanel } from '@/layers/features/chat/ui/TaskDetailPanel';
import { InlineKillButton } from '@/layers/features/chat/ui/InlineKillButton';
import { TASK_COLORS } from '@/layers/features/chat/model/use-background-tasks';
import type { VisibleBackgroundTask } from '@/layers/features/chat/model/use-background-tasks';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  MOCK_SESSION_ID,
  TOOL_CALLS,
  TOOL_CALLS_EXTENDED,
  TOOL_CALLS_WITH_HOOKS,
  TOOL_CALL_APPROVAL,
  BACKGROUND_TASK_PARTS,
  ERROR_PARTS,
} from '../mock-chat-data';

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
};

/** Tool-related component showcases: ToolCallCard, ToolApproval. */
export function ToolShowcases() {
  return (
    <>
      <PlaygroundSection
        title="ToolCallCard"
        description="Tool call cards in all four statuses, collapsed and expanded."
      >
        <ShowcaseDemo>
          <div className="grid gap-4 md:grid-cols-2">
            {(Object.entries(TOOL_CALLS) as [string, (typeof TOOL_CALLS)[string]][]).map(
              ([key, tc]) => (
                <div key={key}>
                  <ShowcaseLabel>{key}</ShowcaseLabel>
                  <ToolCallCard toolCall={tc} />
                </div>
              )
            )}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Expanded by default</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolCallCard toolCall={TOOL_CALLS.complete} defaultExpanded />
        </ShowcaseDemo>

        <ShowcaseLabel>Running with progress output</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolCallCard toolCall={TOOL_CALLS.running_with_progress} />
        </ShowcaseDemo>

        <ShowcaseLabel>Long result (truncated at 5KB)</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolCallCard toolCall={TOOL_CALLS.complete_long_result} defaultExpanded />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ToolCallCard — Extended Labels"
        description="Tool labels for less common tools: task management, notebooks, plan mode, MCP resources."
      >
        <ShowcaseDemo>
          <div className="grid gap-4 md:grid-cols-2">
            {(
              Object.entries(TOOL_CALLS_EXTENDED) as [
                string,
                (typeof TOOL_CALLS_EXTENDED)[string],
              ][]
            ).map(([key, tc]) => (
              <div key={key}>
                <ShowcaseLabel>{key}</ShowcaseLabel>
                <ToolCallCard toolCall={tc} />
              </div>
            ))}
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ToolCallCard — Hook Lifecycle"
        description="Tool call cards with hook sub-rows in all four states: running, success, error, cancelled."
      >
        <ShowcaseDemo>
          <div className="grid gap-4 md:grid-cols-2">
            {(
              Object.entries(TOOL_CALLS_WITH_HOOKS) as [
                string,
                (typeof TOOL_CALLS_WITH_HOOKS)[string],
              ][]
            ).map(([key, tc]) => (
              <div key={key}>
                <ShowcaseLabel>{key}</ShowcaseLabel>
                <ToolCallCard toolCall={tc} />
              </div>
            ))}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>Error hook expanded by default</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolCallCard toolCall={TOOL_CALLS_WITH_HOOKS.hook_error} defaultExpanded />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="SubagentBlock"
        description="Inline subagent lifecycle blocks in all three statuses."
      >
        <ShowcaseDemo>
          <div className="space-y-2">
            {(
              Object.entries(BACKGROUND_TASK_PARTS) as [
                string,
                (typeof BACKGROUND_TASK_PARTS)[string],
              ][]
            ).map(([key, part]) => (
              <div key={key}>
                <ShowcaseLabel>{key}</ShowcaseLabel>
                <SubagentBlock part={part} />
              </div>
            ))}
          </div>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ErrorMessageBlock"
        description="Inline error blocks rendered in the assistant message stream with category-specific copy."
      >
        <ShowcaseDemo>
          <div className="space-y-2">
            {(Object.entries(ERROR_PARTS) as [string, (typeof ERROR_PARTS)[string]][]).map(
              ([key, part]) => (
                <div key={key}>
                  <ShowcaseLabel>{key}</ShowcaseLabel>
                  <ErrorMessageBlock
                    message={part.message}
                    category={part.category}
                    details={part.details}
                  />
                </div>
              )
            )}
          </div>
        </ShowcaseDemo>

        <ShowcaseLabel>execution_error with retry</ShowcaseLabel>
        <ShowcaseDemo>
          <ErrorMessageBlock
            message={ERROR_PARTS.execution_error.message}
            category={ERROR_PARTS.execution_error.category}
            details={ERROR_PARTS.execution_error.details}
            onRetry={() => console.log('[Showcase] Retry clicked')}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ThinkingBlock"
        description="Collapsible extended thinking block with streaming and completed states."
      >
        <ShowcaseLabel>Streaming (expanded, pulsing)</ShowcaseLabel>
        <ShowcaseDemo>
          <ThinkingBlock
            text="Let me analyze this code carefully. The function takes a session ID and looks up the corresponding JSONL file. I need to check if there are any edge cases around file locking..."
            isStreaming
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Completed (5s, collapsed)</ShowcaseLabel>
        <ShowcaseDemo>
          <ThinkingBlock
            text="I analyzed the authentication module and found that the JWT refresh logic has a race condition when two requests arrive simultaneously."
            isStreaming={false}
            elapsedMs={5000}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Completed (2m 5s, collapsed)</ShowcaseLabel>
        <ShowcaseDemo>
          <ThinkingBlock
            text="This was a complex analysis involving multiple service files, their dependencies, and potential blast radius of the proposed refactoring."
            isStreaming={false}
            elapsedMs={125000}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Completed (&lt;1s, collapsed)</ShowcaseLabel>
        <ShowcaseDemo>
          <ThinkingBlock
            text="Quick check confirmed the type is correct."
            isStreaming={false}
            elapsedMs={500}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="CollapsibleRun"
        description="Collapses dense runs of tool/thinking blocks. Shows first 2, then 'and N more steps...' for runs of 4+. Completed cards are dimmed."
      >
        <ShowcaseLabel>Short run (3 items — no collapse, dimmed when complete)</ShowcaseLabel>
        <ShowcaseDemo>
          <CollapsibleRun>
            {[
              <ToolCallCard key="cr-1" toolCall={TOOL_CALLS.complete} />,
              <ThinkingBlock key="cr-2" text="Quick check." isStreaming={false} elapsedMs={800} />,
              <ToolCallCard key="cr-3" toolCall={TOOL_CALLS.complete} />,
            ]}
          </CollapsibleRun>
        </ShowcaseDemo>

        <ShowcaseLabel>Long run (8 items — collapses to 2 + &quot;and 6 more&quot;)</ShowcaseLabel>
        <ShowcaseDemo>
          <CollapsibleRun>
            {[
              <ThinkingBlock
                key="lr-1"
                text="Analyzing the codebase..."
                isStreaming={false}
                elapsedMs={2000}
              />,
              <ToolCallCard key="lr-2" toolCall={TOOL_CALLS.complete} />,
              <ToolCallCard
                key="lr-3"
                toolCall={{ ...TOOL_CALLS.complete, toolCallId: 'lr-3', toolName: 'Edit' }}
              />,
              <ThinkingBlock
                key="lr-4"
                text="Found the issue."
                isStreaming={false}
                elapsedMs={1200}
              />,
              <ToolCallCard
                key="lr-5"
                toolCall={{ ...TOOL_CALLS.complete, toolCallId: 'lr-5', toolName: 'Bash' }}
              />,
              <ThinkingBlock
                key="lr-6"
                text="Verifying fix."
                isStreaming={false}
                elapsedMs={900}
              />,
              <ToolCallCard
                key="lr-7"
                toolCall={{ ...TOOL_CALLS.complete, toolCallId: 'lr-7', toolName: 'Read' }}
              />,
              <ToolCallCard
                key="lr-8"
                toolCall={{ ...TOOL_CALLS.complete, toolCallId: 'lr-8', toolName: 'Grep' }}
              />,
            ]}
          </CollapsibleRun>
        </ShowcaseDemo>

        <ShowcaseLabel>Mixed states (running items stay bright, completed dim)</ShowcaseLabel>
        <ShowcaseDemo>
          <CollapsibleRun>
            {[
              <ToolCallCard key="mx-1" toolCall={TOOL_CALLS.complete} />,
              <ThinkingBlock
                key="mx-2"
                text="Still thinking..."
                isStreaming
                elapsedMs={undefined}
              />,
              <ToolCallCard key="mx-3" toolCall={TOOL_CALLS.running} />,
              <ToolCallCard key="mx-4" toolCall={{ ...TOOL_CALLS.complete, toolCallId: 'mx-4' }} />,
            ]}
          </CollapsibleRun>
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="ToolApproval"
        description="Approval card for pending tool calls. Uses Transport (mock) for approve/deny."
      >
        <ShowcaseLabel>Inactive</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolApproval
            sessionId={MOCK_SESSION_ID}
            toolCallId={TOOL_CALL_APPROVAL.toolCallId}
            toolName={TOOL_CALL_APPROVAL.toolName}
            input={TOOL_CALL_APPROVAL.input}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Active (keyboard shortcut target)</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolApproval
            sessionId={MOCK_SESSION_ID}
            toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-active'}
            toolName={TOOL_CALL_APPROVAL.toolName}
            input={TOOL_CALL_APPROVAL.input}
            isActive
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With countdown timer (10 min)</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolApproval
            sessionId={MOCK_SESSION_ID}
            toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-timer'}
            toolName={TOOL_CALL_APPROVAL.toolName}
            input={TOOL_CALL_APPROVAL.input}
            timeoutMs={600_000}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Warning phase (2 min remaining)</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolApproval
            sessionId={MOCK_SESSION_ID}
            toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-warning'}
            toolName={TOOL_CALL_APPROVAL.toolName}
            input={TOOL_CALL_APPROVAL.input}
            timeoutMs={120_000}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Urgent phase (30s remaining)</ShowcaseLabel>
        <ShowcaseDemo>
          <ToolApproval
            sessionId={MOCK_SESSION_ID}
            toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-urgent'}
            toolName={TOOL_CALL_APPROVAL.toolName}
            input={TOOL_CALL_APPROVAL.input}
            timeoutMs={30_000}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <BackgroundTaskShowcases />
    </>
  );
}

// ---------------------------------------------------------------------------
// Background Task Showcases (new components from background-task-visibility)
// ---------------------------------------------------------------------------

function BackgroundTaskShowcases() {
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
        <ShowcaseLabel>Mixed tasks (agent + bash, running + completed + stopped)</ShowcaseLabel>
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
