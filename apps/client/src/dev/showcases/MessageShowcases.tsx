import { MessageItem } from '@/layers/features/chat/ui/message/MessageItem';
import { UserMessageContent } from '@/layers/features/chat/ui/message/UserMessageContent';
import { AssistantMessageContent } from '@/layers/features/chat/ui/message/AssistantMessageContent';
import { MessageProvider } from '@/layers/features/chat/ui/message/MessageContext';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import {
  createUserMessage,
  createAssistantMessage,
  MOCK_SESSION_ID,
  SAMPLE_MESSAGES,
  TOOL_CALLS,
  TOOL_CALL_APPROVAL,
  TOOL_CALL_QUESTION,
  TOOL_CALL_MULTI_QUESTION,
  SAMPLE_MESSAGE_MULTI_QUESTION,
  TOOL_CALL_MULTI_SELECT_QUESTION,
  SAMPLE_MESSAGE_MULTI_SELECT,
} from '../mock-chat-data';
import type { MessageGrouping } from '@/layers/features/chat/model/chat-types';

const STANDALONE_CTX = {
  sessionId: MOCK_SESSION_ID,
  isStreaming: false,
  activeToolCallId: null,
  onToolRef: undefined,
  focusedOptionIndex: -1,
  onToolDecided: undefined,
  inputZoneToolCallId: null,
};

/** Message-related component showcases: UserMessageContent, AssistantMessageContent, MessageItem. */
export function MessageShowcases() {
  return (
    <>
      <PlaygroundSection
        title="UserMessageContent"
        description="Standalone user message content in different variants."
      >
        <ShowcaseLabel>Plain text</ShowcaseLabel>
        <ShowcaseDemo>
          <UserMessageContent
            message={createUserMessage({
              content: 'Can you refactor the authentication module?',
            })}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Command</ShowcaseLabel>
        <ShowcaseDemo>
          <UserMessageContent
            message={createUserMessage({
              content: '/review src/auth.ts',
              messageType: 'command',
              commandName: 'review',
              commandArgs: 'src/auth.ts',
            })}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Compaction</ShowcaseLabel>
        <ShowcaseDemo>
          <UserMessageContent
            message={createUserMessage({
              content: 'Previous messages have been summarized to save context.',
              messageType: 'compaction',
            })}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>With file attachment mention</ShowcaseLabel>
        <ShowcaseDemo>
          <UserMessageContent
            message={createUserMessage({
              content: 'Here is the config file.\n\n[File: config.json (uploaded)]',
            })}
          />
        </ShowcaseDemo>
      </PlaygroundSection>

      <PlaygroundSection
        title="AssistantMessageContent"
        description="Standalone assistant message content — requires MessageProvider."
      >
        <ShowcaseLabel>Text only</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider value={STANDALONE_CTX}>
            <AssistantMessageContent
              message={createAssistantMessage({
                content: 'Sure, I can help with that refactor.',
              })}
            />
          </MessageProvider>
        </ShowcaseDemo>

        <ShowcaseLabel>With markdown + code</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider value={STANDALONE_CTX}>
            <AssistantMessageContent message={SAMPLE_MESSAGES[1]} />
          </MessageProvider>
        </ShowcaseDemo>

        <ShowcaseLabel>With completed tool call</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider value={STANDALONE_CTX}>
            <AssistantMessageContent message={SAMPLE_MESSAGES[5]} />
          </MessageProvider>
        </ShowcaseDemo>

        <ShowcaseLabel>With approval pending</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider
            value={{
              ...STANDALONE_CTX,
              activeToolCallId: TOOL_CALL_APPROVAL.toolCallId,
            }}
          >
            <AssistantMessageContent message={SAMPLE_MESSAGES[6]} />
          </MessageProvider>
        </ShowcaseDemo>

        <ShowcaseLabel>With question pending</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider
            value={{
              ...STANDALONE_CTX,
              activeToolCallId: TOOL_CALL_QUESTION.toolCallId,
            }}
          >
            <AssistantMessageContent message={SAMPLE_MESSAGES[7]} />
          </MessageProvider>
        </ShowcaseDemo>

        <ShowcaseLabel>With multi-select question pending</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider
            value={{
              ...STANDALONE_CTX,
              activeToolCallId: TOOL_CALL_MULTI_SELECT_QUESTION.toolCallId,
            }}
          >
            <AssistantMessageContent message={SAMPLE_MESSAGE_MULTI_SELECT} />
          </MessageProvider>
        </ShowcaseDemo>

        <ShowcaseLabel>With multiple questions pending</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageProvider
            value={{
              ...STANDALONE_CTX,
              activeToolCallId: TOOL_CALL_MULTI_QUESTION.toolCallId,
            }}
          >
            <AssistantMessageContent message={SAMPLE_MESSAGE_MULTI_QUESTION} />
          </MessageProvider>
        </ShowcaseDemo>
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
            <ShowcaseLabel>{`User — position: ${grouping.position}`}</ShowcaseLabel>
            <ShowcaseDemo>
              <MessageItem
                message={createUserMessage({
                  content: `Message with position="${grouping.position}"`,
                })}
                grouping={grouping}
                sessionId={MOCK_SESSION_ID}
              />
            </ShowcaseDemo>
          </div>
        ))}

        <ShowcaseLabel>Assistant — position: only</ShowcaseLabel>
        <ShowcaseDemo>
          <MessageItem
            message={createAssistantMessage({
              content: 'Here is a short assistant reply.',
            })}
            grouping={{ position: 'only', groupIndex: 1 }}
            sessionId={MOCK_SESSION_ID}
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Assistant with tool calls — position: only</ShowcaseLabel>
        <ShowcaseDemo>
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
        </ShowcaseDemo>
      </PlaygroundSection>
    </>
  );
}
