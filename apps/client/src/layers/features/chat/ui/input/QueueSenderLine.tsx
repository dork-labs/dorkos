import { useNavigate } from '@tanstack/react-router';
import { MessageSquare } from 'lucide-react';
import { AgentAvatar, resolveAgentVisual } from '@/layers/entities/agent';
import { sessionHref, toSession } from '@/layers/shared/lib';
import { UNKNOWN_SENDER, type QueueSender } from '../../lib/queue-sender';

/**
 * The line above a queued message another chat sent (DOR-3060; designer copy):
 * the agent's face and name in ink, then "from" and the chat it came from,
 * quiet, linking there. A chat that can't be read says "can't open" with no
 * link; an unknown sender reads "Another chat" with the chat glyph. On a narrow
 * screen the chat title truncates, never the agent's name.
 */
export function QueueSenderLine({ sender }: { sender: QueueSender | null }) {
  const navigate = useNavigate();
  if (sender === null) {
    return (
      <span className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs">
        <MessageSquare className="size-3 shrink-0" aria-hidden="true" />
        <span className="min-w-0 truncate">{UNKNOWN_SENDER}</span>
      </span>
    );
  }
  const { color, emoji } = resolveAgentVisual({ id: sender.agentId ?? sender.agentName });
  // "from" and the chat title are one piece: with no room beside the name it
  // drops to its own line and truncates there, so the name stays whole and
  // nothing runs under the row's buttons. Only a name wider than the whole
  // line ends in an ellipsis.
  return (
    <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1 text-xs">
      <span className="flex max-w-full shrink-0 items-center gap-1">
        <AgentAvatar color={color} emoji={emoji} size="xs" className="shrink-0" />
        <span className="text-foreground truncate font-semibold">{sender.agentName}</span>
      </span>
      <span className="max-w-full min-w-0 truncate">
        from{' '}
        {sender.chatTitle ? (
          <a
            href={sessionHref({ session: sender.chatId })}
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              void navigate(toSession({ session: sender.chatId }));
            }}
            className="focus-ring rounded-sm underline-offset-4 hover:underline"
          >
            {sender.chatTitle}
          </a>
        ) : (
          'another chat · can’t open'
        )}
      </span>
    </span>
  );
}
