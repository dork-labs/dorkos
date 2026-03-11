import { ToolCallCard } from '@/layers/features/chat/ui/ToolCallCard';
import { ToolApproval } from '@/layers/features/chat/ui/ToolApproval';
import { PlaygroundSection } from '../PlaygroundSection';
import { TOOL_CALLS, TOOL_CALL_APPROVAL } from '../mock-chat-data';

const MOCK_SESSION_ID = 'playground-session-001';

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
      {children}
    </div>
  );
}

/** Tool-related component showcases: ToolCallCard, ToolApproval. */
export function ToolShowcases() {
  return (
    <>
      <PlaygroundSection
        title="ToolCallCard"
        description="Tool call cards in all four statuses, collapsed and expanded."
      >
        <div className="grid gap-4 md:grid-cols-2">
          {(Object.entries(TOOL_CALLS) as [string, (typeof TOOL_CALLS)[string]][]).map(
            ([key, tc]) => (
              <div key={key}>
                <Label>{key}</Label>
                <ToolCallCard toolCall={tc} />
              </div>
            )
          )}
        </div>

        <Label>Expanded by default</Label>
        <ToolCallCard toolCall={TOOL_CALLS.complete} defaultExpanded />
      </PlaygroundSection>

      <PlaygroundSection
        title="ToolApproval"
        description="Approval card for pending tool calls. Uses Transport (mock) for approve/deny."
      >
        <Label>Inactive</Label>
        <ToolApproval
          sessionId={MOCK_SESSION_ID}
          toolCallId={TOOL_CALL_APPROVAL.toolCallId}
          toolName={TOOL_CALL_APPROVAL.toolName}
          input={TOOL_CALL_APPROVAL.input}
        />

        <Label>Active (keyboard shortcut target)</Label>
        <ToolApproval
          sessionId={MOCK_SESSION_ID}
          toolCallId={TOOL_CALL_APPROVAL.toolCallId + '-active'}
          toolName={TOOL_CALL_APPROVAL.toolName}
          input={TOOL_CALL_APPROVAL.input}
          isActive
        />
      </PlaygroundSection>
    </>
  );
}
