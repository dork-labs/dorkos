import { ToolCallCard } from '@/layers/features/chat/ui/tools/ToolCallCard';
import { BackgroundTaskShowcases } from './BackgroundTaskShowcases';
import { SubagentBlock } from '@/layers/features/chat/ui/message/SubagentBlock';
import { ErrorMessageBlock } from '@/layers/features/chat/ui/message/ErrorMessageBlock';
import { ThinkingBlock } from '@/layers/features/chat/ui/message/ThinkingBlock';
import { CollapsibleRun } from '@/layers/features/chat/ui/message/CollapsibleRun';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  TOOL_CALLS,
  TOOL_CALLS_EXTENDED,
  TOOL_CALLS_WITH_HOOKS,
  BACKGROUND_TASK_PARTS,
  ERROR_PARTS,
} from '../mock-chat-data';

/**
 * Tool-related component showcases: ToolCallCard and friends.
 *
 * The tool-call APPROVAL prompt (`ApprovalPrompt`) and its receipt
 * (`AskReceipt`) moved to `AsksShowcases.tsx` (DOR-1332, P5) — they are Ask
 * surfaces, not tool-call rendering, and the Conversation page's Asks section
 * is where the whole Ask card family lives now.
 */
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
        description="Inline subagent lifecycle blocks across statuses, including live forwarded text (expand the 'streaming' variant)."
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

      <BackgroundTaskShowcases />
    </>
  );
}
