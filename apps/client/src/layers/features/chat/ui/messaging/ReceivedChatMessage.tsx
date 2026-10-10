/**
 * A message another chat sent this one, as the receiving chat draws it (spec
 * `spin-off-chats` §6): the same row a person's message gets — the same
 * layout and markdown — so it reads as conversation, with a tinted edge so
 * nobody takes it for their own words at a glance. Who sent it is in the row's
 * author line ({@link ChatFromMark}); never "You".
 *
 * @module features/chat/ui/messaging/ReceivedChatMessage
 */
import { useNavigate } from '@tanstack/react-router';
import { CornerUpLeft } from 'lucide-react';
import type { ChatMessageStamp } from '@dorkos/shared/chat-messages';
import { toSession } from '@/layers/shared/lib';
import { StreamingText } from '../message/StreamingText';
import { stampTags } from '../../lib/chat-messaging';

/** The small tags a received message carries, in one quiet run. */
export function ChatMessageTags({ stamp }: { stamp: Pick<ChatMessageStamp, 'kind' | 'delivery'> }) {
  const tags = stampTags(stamp);
  if (tags.length === 0) return null;
  return (
    <>
      {tags.map((tag) => (
        <span
          key={tag}
          data-testid="chat-message-tag"
          className="bg-muted text-muted-foreground rounded px-1.5 py-px text-[11px] leading-4 font-medium"
        >
          {tag}
        </span>
      ))}
    </>
  );
}

/**
 * "· from <chat>" beside the sender's name, linking to the chat that sent it,
 * plus the message's tags. Part of the author line, so it is never behind a
 * hover.
 *
 * @param props - The first stamp the message carries.
 */
export function ChatFromMark({ stamp }: { stamp: ChatMessageStamp }) {
  const navigate = useNavigate();
  const title = stamp.from.chatTitle ?? 'another chat';
  return (
    <span
      data-testid="chat-from-mark"
      className="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-xs"
    >
      <span className="text-muted-foreground inline-flex min-w-0 items-center gap-1">
        <span aria-hidden>·</span>
        <span>from</span>
        <button
          type="button"
          onClick={() =>
            void navigate(toSession({ session: stamp.from.chatId, message: stamp.id }))
          }
          className="focus-ring text-foreground/80 hover:text-foreground max-w-48 truncate underline-offset-4 hover:underline"
        >
          {title}
        </button>
      </span>
      <ChatMessageTags stamp={stamp} />
    </span>
  );
}

/**
 * "Reply to your message": a received message that answers one this chat
 * sent links back to that message's Sent card, in this chat.
 *
 * @param props - This chat, and the chat message the reply answers.
 */
function ReplyToYourMessage({ sessionId, messageId }: { sessionId: string; messageId: string }) {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      data-testid="chat-reply-to"
      onClick={() => void navigate(toSession({ session: sessionId, message: messageId }))}
      className="focus-ring text-muted-foreground hover:text-foreground focus-visible:text-foreground mb-1 inline-flex items-center gap-1 text-xs underline-offset-4 hover:underline"
    >
      <CornerUpLeft aria-hidden className="size-3" />
      Reply to your message
    </button>
  );
}

/**
 * The body of a user message that carries messages from other chats: each
 * one's words, in a tinted block. Several stamps mean agent messages that
 * waited together and ran as one turn; each beyond the first says who sent it.
 *
 * @param props - The stamps and the chat they arrived in.
 */
export function ReceivedChatMessages({
  stamps,
  sessionId,
}: {
  stamps: readonly ChatMessageStamp[];
  sessionId?: string;
}) {
  return (
    <div className="space-y-2" data-testid="received-chat-messages">
      {stamps.map((stamp, index) => (
        <div
          key={stamp.id}
          data-testid="received-chat-message"
          data-kind={stamp.kind}
          className="border-status-info-border bg-status-info-bg rounded-r-md border-l-2 py-1.5 pr-2 pl-3"
        >
          {stamp.replyToId && sessionId && (
            <ReplyToYourMessage sessionId={sessionId} messageId={stamp.replyToId} />
          )}
          {index > 0 && (
            <div className="text-muted-foreground mb-1 flex flex-wrap items-center gap-1.5 text-xs">
              <span className="text-foreground/80 font-medium">{stamp.from.agentName}</span>
              <ChatFromMark stamp={stamp} />
            </div>
          )}
          <div className="msg-prose">
            <StreamingText
              content={stamp.text}
              isStreaming={false}
              {...(sessionId ? { sessionId } : {})}
            />
          </div>
        </div>
      ))}
    </div>
  );
}
