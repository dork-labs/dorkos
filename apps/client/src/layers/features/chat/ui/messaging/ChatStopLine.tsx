/**
 * "Stopped by <agent> · <chat>: <reason>" — the line a chat shows where another
 * chat's agent stopped it (spec `spin-off-chats` §6). Agents can do what
 * people can, so a stop is allowed; it is never silent.
 *
 * @module features/chat/ui/messaging/ChatStopLine
 */
import { useNavigate } from '@tanstack/react-router';
import { CircleStop } from 'lucide-react';
import type { ChatStopNotice } from '@dorkos/shared/chat-messages';
import { toSession } from '@/layers/shared/lib';

/**
 * One stop, as a quiet system line.
 *
 * @param props - The stop.
 */
export function ChatStopLine({ notice }: { notice: ChatStopNotice }) {
  const navigate = useNavigate();
  return (
    <div
      data-testid="chat-stop-line"
      className="text-muted-foreground flex flex-wrap items-center gap-1.5 text-xs"
    >
      <CircleStop aria-hidden className="size-3.5 shrink-0" />
      <span>
        Stopped by <span className="text-foreground/80 font-medium">{notice.by.agentName}</span>
        {' · '}
        <button
          type="button"
          onClick={() => void navigate(toSession({ session: notice.by.chatId }))}
          className="focus-ring hover:text-foreground underline-offset-4 hover:underline"
        >
          {notice.by.chatTitle ?? 'another chat'}
        </button>
        {notice.reason ? `: ${notice.reason}` : ''}
      </span>
    </div>
  );
}
