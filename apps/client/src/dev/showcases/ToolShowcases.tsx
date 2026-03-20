import { ToolCallCard } from '@/layers/features/chat/ui/ToolCallCard';
import { ToolApproval } from '@/layers/features/chat/ui/ToolApproval';
import { SubagentBlock } from '@/layers/features/chat/ui/SubagentBlock';
import { ErrorMessageBlock } from '@/layers/features/chat/ui/ErrorMessageBlock';
import { ThinkingBlock } from '@/layers/features/chat/ui/ThinkingBlock';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  MOCK_SESSION_ID,
  TOOL_CALLS,
  TOOL_CALLS_EXTENDED,
  TOOL_CALLS_WITH_HOOKS,
  TOOL_CALL_APPROVAL,
  SUBAGENT_PARTS,
  ERROR_PARTS,
} from '../mock-chat-data';

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
            {(Object.entries(SUBAGENT_PARTS) as [string, (typeof SUBAGENT_PARTS)[string]][]).map(
              ([key, part]) => (
                <div key={key}>
                  <ShowcaseLabel>{key}</ShowcaseLabel>
                  <SubagentBlock part={part} />
                </div>
              )
            )}
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
    </>
  );
}
