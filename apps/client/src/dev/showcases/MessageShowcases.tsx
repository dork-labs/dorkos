import { SessionMessage } from '@/layers/features/chat/ui/message/SessionMessage';
import { Conversation, MessageAuthorAvatar } from '@/layers/features/conversation';
import { UserMessageContent } from '@/layers/features/chat/ui/message/UserMessageContent';
import { AssistantMessageContent } from '@/layers/features/chat/ui/message/AssistantMessageContent';
import { MessageProvider } from '@/layers/features/chat/ui/message/MessageContext';
import { PermissionDeniedChip } from '@/layers/features/chat/ui/message/PermissionDeniedChip';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { MessageRowShowcases } from './MessageRowShowcases';
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
import type { MessageAuthor } from '@/layers/shared/model';
import { SESSION_CAPABILITIES } from '@/layers/features/chat';

/** Stand-in participants for the identity gutter. */
const HUMAN_AUTHOR: MessageAuthor = { kind: 'human', id: 'human', displayName: 'You' };
const AGENT_AUTHOR: MessageAuthor = {
  kind: 'agent',
  id: 'dorkbot',
  displayName: 'DorkBot',
  emoji: '\u{1F916}',
  color: 'hsl(210, 70%, 55%)',
};
const SYSTEM_AUTHOR: MessageAuthor = { kind: 'system', id: 'system', displayName: 'System' };
/**
 * The common shape an agent actually renders through: no stored emoji, no
 * stored colour (verified live — roughly 16% of agents have an icon, 5% a
 * colour). The filled square this falls back to has to stay legible on
 * whatever the id hashes to, not just on a hand-picked brand colour like
 * {@link AGENT_AUTHOR} above.
 */
const AGENT_AUTHOR_UNBRANDED: MessageAuthor = {
  kind: 'agent',
  id: 'lifeos',
  displayName: 'LifeOS',
};
/**
 * Session chat's other common case: no agent for the session, so
 * `resolveMessageAuthor` falls back to the runtime's own brand — its color is
 * a theme token (`var(--color-orange-500)`), not a concrete color, which is
 * why this one draws tinted rather than filled (`readableForeground` cannot
 * read a `var()` token — see `MessageAuthorAvatar`'s own doc).
 */
const AGENT_AUTHOR_RUNTIME_BRAND: MessageAuthor = {
  kind: 'agent',
  id: 'runtime:claude-code',
  displayName: 'Claude Code',
  runtime: 'claude-code',
};
/** A person bridged into the room from outside this machine — the Send badge's one case. */
const EXTERNAL_HUMAN_AUTHOR: MessageAuthor = {
  kind: 'human',
  id: 'author-bo',
  displayName: 'Bo',
  isExternal: true,
};

const STANDALONE_CTX = {
  sessionId: MOCK_SESSION_ID,
  isStreaming: false,
  isLatestWidgetMessage: true,
  activeToolCallId: null,
  onToolRef: undefined,
  focusedOptionIndex: -1,
  onToolDecided: undefined,
  inputZoneToolCallId: null,
};

/** Message-related component showcases: the shared row, its content, and its identity. */
export function MessageShowcases() {
  return (
    <>
      <MessageRowShowcases />
      <PlaygroundSection
        title="PermissionDeniedChip"
        description="Read-only chip marking a tool call blocked before execution by the auto-mode safety classifier — distinct from a user denial, with no actions or re-approval."
      >
        <ShowcaseLabel>Classifier denial (with reason)</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionDeniedChip
            toolName="Bash"
            reasonType="classifier"
            reason="Destructive shell command (rm -rf)"
            message="Blocked by the safety classifier."
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Classifier denial (message fallback)</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionDeniedChip
            toolName="Write"
            reasonType="classifier"
            message="Writing outside the working directory was blocked."
          />
        </ShowcaseDemo>

        <ShowcaseLabel>Non-classifier denial</ShowcaseLabel>
        <ShowcaseDemo>
          <PermissionDeniedChip
            toolName="WebFetch"
            reasonType="rule"
            message="A permission rule blocked this call."
          />
        </ShowcaseDemo>
      </PlaygroundSection>

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

        <ShowcaseLabel>Local command output (/context, /usage, …)</ShowcaseLabel>
        <ShowcaseDemo>
          <UserMessageContent
            message={createUserMessage({
              content:
                '\x1b[1mContext Usage\x1b[0m\n\x1b[32m█████████\x1b[0m\x1b[90m░░░░░░░░░░░\x1b[0m 45%\n\nSystem prompt   2.3k tokens\nTools          11.1k tokens\nMessages       45.2k tokens',
              messageType: 'local_command_output',
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
        title="SessionMessage"
        description="Full SessionMessage component with grouping positions."
      >
        {(
          [
            { position: 'only' },
            { position: 'first' },
            { position: 'middle' },
            { position: 'last' },
          ] satisfies MessageGrouping[]
        ).map((grouping) => (
          <div key={grouping.position}>
            <ShowcaseLabel>{`User — position: ${grouping.position}`}</ShowcaseLabel>
            <ShowcaseDemo>
              <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
                <SessionMessage
                  message={createUserMessage({
                    content: `Message with position="${grouping.position}"`,
                  })}
                  grouping={grouping}
                  author={HUMAN_AUTHOR}
                  sessionId={MOCK_SESSION_ID}
                />
              </Conversation.Root>
            </ShowcaseDemo>
          </div>
        ))}

        <ShowcaseLabel>Assistant — position: only</ShowcaseLabel>
        <ShowcaseDemo>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <SessionMessage
              message={createAssistantMessage({
                content: 'Here is a short assistant reply.',
              })}
              grouping={{ position: 'only' }}
              author={AGENT_AUTHOR}
              sessionId={MOCK_SESSION_ID}
            />
          </Conversation.Root>
        </ShowcaseDemo>

        <ShowcaseLabel>Assistant with tool calls — position: only</ShowcaseLabel>
        <ShowcaseDemo>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <SessionMessage
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
              grouping={{ position: 'only' }}
              author={AGENT_AUTHOR}
              sessionId={MOCK_SESSION_ID}
            />
          </Conversation.Root>
        </ShowcaseDemo>

        <ShowcaseLabel>Local command (/context) — prompt + full-width output</ShowcaseLabel>
        <ShowcaseDemo>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <SessionMessage
              message={createUserMessage({ content: '/context', messageType: 'command' })}
              grouping={{ position: 'first' }}
              author={HUMAN_AUTHOR}
              sessionId={MOCK_SESSION_ID}
            />
          </Conversation.Root>
          <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
            <SessionMessage
              message={createUserMessage({
                content:
                  '\x1b[1mContext Usage\x1b[0m\n\x1b[32m█████████\x1b[0m\x1b[90m░░░░░░░░░░░\x1b[0m 45%\n\nSystem prompt   2.3k tokens\nTools          11.1k tokens\nMessages       45.2k tokens',
                messageType: 'local_command_output',
              })}
              grouping={{ position: 'last' }}
              author={SYSTEM_AUTHOR}
              sessionId={MOCK_SESSION_ID}
            />
          </Conversation.Root>
        </ShowcaseDemo>
      </PlaygroundSection>

      <MessageAuthorAvatarShowcase />
    </>
  );
}

/**
 * Who is speaking, as the feed draws them.
 *
 * Its own exported component because the Identity page renders it too — it is a
 * chat surface first, so its registry entry stays on Chat and its anchor with it
 * (spec `identity-consistency` §W4.2).
 */
export function MessageAuthorAvatarShowcase() {
  return (
    <PlaygroundSection
      title="MessageAuthorAvatar"
      description="Shape and fill are the colourblind-safe signal for who is speaking, in both the room feed and session chat (spec composer-identity-components, direction C): an agent draws as a filled square with a small Bot badge; a person stays a tinted circle, gaining a Send badge only when they are bridged in from outside this machine. The unbranded agent below is the common case, not the exception — its fallback letter still has to read against whatever the id hashes to. The runtime-brand agent stays square but draws TINTED rather than filled: its colour is a theme token, which the fill variant's contrast pass cannot parse, so it falls back to the same tint every person uses."
    >
      <ShowcaseLabel>Agent — stored emoji and colour</ShowcaseLabel>
      <ShowcaseDemo>
        <MessageAuthorAvatar author={AGENT_AUTHOR} />
      </ShowcaseDemo>

      <ShowcaseLabel>Agent — no stored emoji or colour (the common case)</ShowcaseLabel>
      <ShowcaseDemo>
        <MessageAuthorAvatar author={AGENT_AUTHOR_UNBRANDED} />
      </ShowcaseDemo>

      <ShowcaseLabel>Agent — runtime brand fallback, no agent for the session</ShowcaseLabel>
      <ShowcaseDemo>
        <MessageAuthorAvatar author={AGENT_AUTHOR_RUNTIME_BRAND} />
      </ShowcaseDemo>

      <ShowcaseLabel>Person — on this machine</ShowcaseLabel>
      <ShowcaseDemo>
        <MessageAuthorAvatar author={HUMAN_AUTHOR} />
      </ShowcaseDemo>

      <ShowcaseLabel>Person — bridged in from another platform</ShowcaseLabel>
      <ShowcaseDemo>
        <MessageAuthorAvatar author={EXTERNAL_HUMAN_AUTHOR} />
      </ShowcaseDemo>

      <ShowcaseLabel>System</ShowcaseLabel>
      <ShowcaseDemo>
        <MessageAuthorAvatar author={SYSTEM_AUTHOR} />
      </ShowcaseDemo>

      <ShowcaseLabel>
        Agent — as a control, when the surface can name whose profile it opens (Tab to it)
      </ShowcaseLabel>
      <ShowcaseDemo>
        {/* The only state above that is not decoration. The room feed passes a
            destination when it can join the entry's author to the fleet; every
            other host leaves the disc exactly as the rows above it. The focus
            ring rides the disc's own radius, so an agent's square rings square. */}
        <MessageAuthorAvatar author={AGENT_AUTHOR} onViewProfile={() => {}} />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
