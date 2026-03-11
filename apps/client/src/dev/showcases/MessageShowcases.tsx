import { MessageItem } from '@/layers/features/chat/ui/message/MessageItem';
import { UserMessageContent } from '@/layers/features/chat/ui/message/UserMessageContent';
import { AssistantMessageContent } from '@/layers/features/chat/ui/message/AssistantMessageContent';
import { MessageProvider } from '@/layers/features/chat/ui/message/MessageContext';
import { PlaygroundSection } from '../PlaygroundSection';
import {
  createUserMessage,
  createAssistantMessage,
  SAMPLE_MESSAGES,
  TOOL_CALLS,
  TOOL_CALL_APPROVAL,
  TOOL_CALL_QUESTION,
} from '../mock-chat-data';
import type { MessageGrouping } from '@/layers/features/chat/model/chat-types';

const MOCK_SESSION_ID = 'playground-session-001';

const STANDALONE_CTX = {
  sessionId: MOCK_SESSION_ID,
  isStreaming: false,
  activeToolCallId: null,
  onToolRef: undefined,
  focusedOptionIndex: -1,
  onToolDecided: undefined,
};

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-muted-foreground mb-2 text-xs font-medium uppercase tracking-wider">
      {children}
    </div>
  );
}

/** Message-related component showcases: UserMessageContent, AssistantMessageContent, MessageItem. */
export function MessageShowcases() {
  return (
    <>
      <PlaygroundSection
        title="UserMessageContent"
        description="Standalone user message content in different variants."
      >
        <Label>Plain text</Label>
        <UserMessageContent
          message={createUserMessage({
            content: 'Can you refactor the authentication module?',
          })}
        />

        <Label>Command</Label>
        <UserMessageContent
          message={createUserMessage({
            content: '/review src/auth.ts',
            messageType: 'command',
            commandName: 'review',
            commandArgs: 'src/auth.ts',
          })}
        />

        <Label>Compaction</Label>
        <UserMessageContent
          message={createUserMessage({
            content: 'Previous messages have been summarized to save context.',
            messageType: 'compaction',
          })}
        />

        <Label>With file attachment mention</Label>
        <UserMessageContent
          message={createUserMessage({
            content:
              'Here is the config file.\n\n[File: config.json (uploaded)]',
          })}
        />
      </PlaygroundSection>

      <PlaygroundSection
        title="AssistantMessageContent"
        description="Standalone assistant message content — requires MessageProvider."
      >
        <Label>Text only</Label>
        <MessageProvider value={STANDALONE_CTX}>
          <AssistantMessageContent
            message={createAssistantMessage({
              content: 'Sure, I can help with that refactor.',
            })}
          />
        </MessageProvider>

        <Label>With markdown + code</Label>
        <MessageProvider value={STANDALONE_CTX}>
          <AssistantMessageContent message={SAMPLE_MESSAGES[1]} />
        </MessageProvider>

        <Label>With completed tool call</Label>
        <MessageProvider value={STANDALONE_CTX}>
          <AssistantMessageContent message={SAMPLE_MESSAGES[5]} />
        </MessageProvider>

        <Label>With approval pending</Label>
        <MessageProvider
          value={{
            ...STANDALONE_CTX,
            activeToolCallId: TOOL_CALL_APPROVAL.toolCallId,
          }}
        >
          <AssistantMessageContent message={SAMPLE_MESSAGES[6]} />
        </MessageProvider>

        <Label>With question pending</Label>
        <MessageProvider
          value={{
            ...STANDALONE_CTX,
            activeToolCallId: TOOL_CALL_QUESTION.toolCallId,
          }}
        >
          <AssistantMessageContent message={SAMPLE_MESSAGES[7]} />
        </MessageProvider>
      </PlaygroundSection>

      <PlaygroundSection
        title="MessageItem"
        description="Full MessageItem component with grouping positions."
      >
        {(
          [
            { position: 'only', groupIndex: 0 },
            { position: 'first', groupIndex: 0 },
            { position: 'middle', groupIndex: 0 },
            { position: 'last', groupIndex: 0 },
          ] satisfies MessageGrouping[]
        ).map((grouping) => (
          <div key={grouping.position}>
            <Label>User — position: {grouping.position}</Label>
            <MessageItem
              message={createUserMessage({
                content: `Message with position="${grouping.position}"`,
              })}
              grouping={grouping}
              sessionId={MOCK_SESSION_ID}
            />
          </div>
        ))}

        <Label>Assistant — position: only</Label>
        <MessageItem
          message={createAssistantMessage({
            content: 'Here is a short assistant reply.',
          })}
          grouping={{ position: 'only', groupIndex: 1 }}
          sessionId={MOCK_SESSION_ID}
        />

        <Label>Assistant with tool calls — position: only</Label>
        <MessageItem
          message={createAssistantMessage({
            content: 'Let me check that file for you.',
            toolCalls: [TOOL_CALLS.complete],
            parts: [
              { type: 'text', text: 'Let me check that file for you.' },
              {
                type: 'tool_call',
                toolCallId: TOOL_CALLS.complete.toolCallId,
                toolName: 'Edit',
                input: TOOL_CALLS.complete.input,
                result: TOOL_CALLS.complete.result,
                status: 'complete',
              },
            ],
          })}
          grouping={{ position: 'only', groupIndex: 2 }}
          sessionId={MOCK_SESSION_ID}
        />
      </PlaygroundSection>
    </>
  );
}
