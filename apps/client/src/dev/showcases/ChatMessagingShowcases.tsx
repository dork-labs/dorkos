/**
 * Chats messaging chats (spec `spin-off-chats` §6): the Sent card in the
 * sending chat, the received message in the receiving one, and the line a
 * chat shows when another chat's agent stopped it.
 *
 * @module dev/showcases/ChatMessagingShowcases
 */
import type { ChatMessageStamp, SentChatMessage } from '@dorkos/shared/chat-messages';
import { ChatStopLine, resolveMessageAuthor, SentChatCard } from '@/layers/features/chat';
import { Conversation } from '@/layers/features/conversation';
import { SESSION_CAPABILITIES, SessionMessage } from '@/layers/widgets/session';
import { PlaygroundSection } from '../PlaygroundSection';
import { ShowcaseLabel } from '../ShowcaseLabel';
import { ShowcaseDemo } from '../ShowcaseDemo';
import { createUserMessage } from '../mock-factories';
import { MOCK_SESSION_ID } from '../mock-chat-data';

const AT = '2026-10-09T14:32:00.000Z';
const BUILDER = { agentName: 'Builder', agentId: 'agent-builder' };
const RELEASE = { agentName: 'Release manager', agentId: 'agent-release' };

/** One sent message, as the server reports it. */
function sent(over: Partial<SentChatMessage> & Pick<SentChatMessage, 'id'>): SentChatMessage {
  return {
    kind: 'message',
    to: { chatId: 'chat-b', chatTitle: 'Fix the flaky upload test', ...BUILDER },
    text: 'The upload test fails about one run in five on CI. Can you find why and fix it?',
    summary: 'Fix the flaky upload test',
    delivery: 'queue',
    status: 'queued',
    sentAt: AT,
    ...over,
  };
}

/** A `chat_send` call and its receipt, as the transcript stores them. */
function sendCall(id: string, input: Record<string, unknown>, ok = true) {
  return {
    toolName: 'mcp__dorkos__chat_send',
    input: JSON.stringify(input),
    result: JSON.stringify(
      ok
        ? { ok: true, messageId: id, chatId: 'chat-b', status: 'queued' }
        : { ok: false, code: 'NOT_ALLOWED', error: 'That chat belongs to a room.' }
    ),
    status: 'complete',
  };
}

const SENT: SentChatMessage[] = [
  sent({ id: 'm-queued', position: 2 }),
  sent({ id: 'm-working', status: 'working' }),
  sent({ id: 'm-delivered', status: 'delivered' }),
  sent({ id: 'm-replied', status: 'replied', replyId: 'r1' }),
  sent({
    id: 'm-steered',
    status: 'steered',
    delivery: 'steer',
    summary: 'Use the staging bucket',
  }),
  sent({
    id: 'm-interrupt',
    status: 'working',
    delivery: 'interrupt',
    summary: 'Stop, wrong branch',
  }),
  sent({
    id: 'm-failed',
    status: 'failed',
    failureReason: 'The chat it was waiting in no longer exists.',
  }),
  sent({
    id: 'm-start',
    kind: 'start',
    to: { chatId: 'chat-new', chatTitle: 'Release v0.102.0', ...RELEASE },
    text: 'Cut the v0.102.0 release. Done means the npm packages and the desktop build are out.',
    status: 'working',
    summary: undefined,
  }),
];

const STAMP: ChatMessageStamp = {
  id: 'stamp-1',
  kind: 'message',
  from: {
    chatId: 'chat-a',
    chatTitle: 'Plan the week',
    agentName: 'Coordinator',
    agentId: 'agent-coord',
  },
  text: 'The upload test fails about one run in five on CI. Can you find why and fix it?',
  delivery: 'queue',
  status: 'working',
  sentAt: AT,
};

const RECEIVED = [
  { label: 'A message from another chat', stamps: [STAMP] },
  {
    label: 'A spin-off reporting back',
    stamps: [
      {
        ...STAMP,
        id: 'stamp-2',
        kind: 'report' as const,
        from: { chatId: 'chat-b', chatTitle: 'Fix the flaky upload test', ...BUILDER },
        text: 'Finished this turn.\n\nThe test raced the upload’s cleanup. Fixed in **#2701**; CI is green three runs in a row.',
      },
    ],
  },
  {
    label: 'A reply to a message this chat sent',
    stamps: [
      {
        ...STAMP,
        id: 'stamp-5',
        from: { chatId: 'chat-b', chatTitle: 'Fix the flaky upload test', ...BUILDER },
        text: 'Yes, the staging bucket. Done.',
        replyToId: 'm-replied',
      },
    ],
  },
  {
    label: 'Steered into a running turn',
    stamps: [
      {
        ...STAMP,
        id: 'stamp-3',
        delivery: 'steer' as const,
        text: 'Use the staging bucket, not prod.',
      },
    ],
  },
  {
    label: 'Two agent messages that waited together, run as one turn',
    stamps: [
      STAMP,
      {
        ...STAMP,
        id: 'stamp-4',
        kind: 'report' as const,
        from: { chatId: 'chat-c', chatTitle: 'Release v0.102.0', ...RELEASE },
        text: 'Waiting on the person to answer before it can go on.\n\nIt asks to publish to npm.',
      },
    ],
  },
];

/** The Sent card in all its states, received messages, and the stop line. */
export function ChatMessagingShowcases() {
  return (
    <PlaygroundSection
      title="Chat messaging"
      description="One chat messaging another: the Sent card, the received message, and a stop. Never hidden with tool calls."
    >
      <ShowcaseLabel>Sent card · every state (click one to open it)</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-2xl">
          <SentChatCard
            part={sendCall('m-queued', {
              to: 'chat-b',
              message: SENT[0]!.text,
              summary: SENT[0]!.summary,
            })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-working', { to: 'chat-b', message: SENT[1]!.text })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-delivered', { to: 'chat-b', message: SENT[2]!.text })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-replied', { to: 'chat-b', message: SENT[3]!.text })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-steered', {
              to: 'chat-b',
              message: 'Use the staging bucket.',
              delivery: 'steer',
            })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-interrupt', {
              to: 'chat-b',
              message: 'Stop, wrong branch.',
              delivery: 'interrupt',
            })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-failed', { to: 'chat-b', message: SENT[6]!.text })}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={sendCall('m-refused', { to: 'room-chat', message: 'Hello' }, false)}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={{
              toolName: 'mcp__dorkos__chat_send',
              input: JSON.stringify({ to: 'chat-b', message: 'On my way.' }),
              status: 'running',
            }}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={{
              toolName: 'mcp__dorkos__chat_send',
              input: JSON.stringify({ to: 'chat-b', message: 'Ship it.' }),
              result: JSON.stringify({ status: 'approval_required', message: 'Held.' }),
              status: 'complete',
            }}
            sent={SENT}
            at={AT}
          />
        </div>
      </ShowcaseDemo>

      <ShowcaseLabel>Starting a spin-off, and stopping one</ShowcaseLabel>
      <ShowcaseDemo>
        <div className="max-w-2xl">
          <SentChatCard
            part={{
              toolName: 'mcp__dorkos__session_start',
              input: JSON.stringify({ prompt: SENT[7]!.text, cwd: '/work' }),
              result: JSON.stringify({ sessionId: 'chat-new', status: 'started' }),
              status: 'complete',
            }}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={{
              toolName: 'mcp__dorkos__chat_stop',
              input: JSON.stringify({ chat: 'chat-b', reason: 'Working on the wrong branch' }),
              result: JSON.stringify({
                ok: true,
                stopped: true,
                chatId: 'chat-b',
                droppedMessages: 0,
                note: 'Stopped.',
              }),
              status: 'complete',
            }}
            sent={SENT}
            at={AT}
          />
          <SentChatCard
            part={{
              toolName: 'mcp__dorkos__chat_stop',
              input: JSON.stringify({ chat: 'chat-b' }),
              result: JSON.stringify({
                stopped: false,
                chatId: 'chat-b',
                droppedMessages: 0,
                note: 'Nothing was running there.',
              }),
              status: 'complete',
            }}
            sent={SENT}
            at={AT}
          />
        </div>
      </ShowcaseDemo>

      {RECEIVED.map(({ label, stamps }) => {
        const message = createUserMessage({
          content: '(fenced)',
          timestamp: AT,
          chatMessages: stamps,
        });
        return (
          <div key={label}>
            <ShowcaseLabel>{`Received · ${label}`}</ShowcaseLabel>
            <ShowcaseDemo>
              <div className="max-w-2xl">
                <Conversation.Root surface="session" capabilities={SESSION_CAPABILITIES}>
                  <SessionMessage
                    message={message}
                    grouping={{ position: 'only' }}
                    author={resolveMessageAuthor(message, {})}
                    sessionId={MOCK_SESSION_ID}
                  />
                </Conversation.Root>
              </div>
            </ShowcaseDemo>
          </div>
        );
      })}

      <ShowcaseLabel>Stopped by another chat</ShowcaseLabel>
      <ShowcaseDemo>
        <ChatStopLine
          notice={{
            id: 'stop-1',
            by: { chatId: 'chat-a', chatTitle: 'Plan the week', agentName: 'Coordinator' },
            reason: 'Working on the wrong branch',
            at: AT,
          }}
        />
      </ShowcaseDemo>
    </PlaygroundSection>
  );
}
