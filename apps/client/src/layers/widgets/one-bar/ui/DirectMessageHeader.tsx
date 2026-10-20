/**
 * The bar over a chat drawn as a direct message with one agent (DOR-3074):
 * who you are talking to, what it is doing, where else you meet it, and, with
 * Show sessions on, a door to the working session behind the chat.
 *
 * @module widgets/one-bar/ui/DirectMessageHeader
 */
import { useNavigate } from '@tanstack/react-router';
import { Terminal } from 'lucide-react';
import type { DirectChat } from '@dorkos/shared/room-schemas';
import { appRoutes, cn } from '@/layers/shared/lib';
import { statusDotClass } from '@/layers/shared/ui';
import { AgentAvatar } from '@/layers/entities/agent';
import { useShowSessions } from '@/layers/entities/config';
import { useSessionStatusSignals } from '@/layers/entities/session';
import {
  splitSharedChannels,
  useDirectMessageAgent,
  useSessionViewLinks,
  useSharedChannels,
  type SharedChannel,
} from '@/layers/features/direct-message';
import { useSessionDiagnostics } from '@/layers/features/status';
import { OneBar } from './OneBar';

/** What {@link DirectMessageHeader} draws. */
export interface DirectMessageHeaderProps {
  /** The session on screen, which is the agent's Direct chat. */
  sessionId: string;
  /** The Direct chat it is. */
  chat: DirectChat;
}

/**
 * `[face] name · ● working` or `· role`, then `Also in #design, #launch` and the
 * session chip on the right. The search, inbox and panel toggle stay where every
 * bar has them, after this.
 *
 * Nothing about the session's machinery is here at rest: the model, account,
 * permissions and context belong to the session view, which the chip opens.
 */
export function DirectMessageHeader({ sessionId, chat }: DirectMessageHeaderProps) {
  const agent = useDirectMessageAgent(chat.agentPath);
  const { working } = useSessionStatusSignals(sessionId);
  const channels = useSharedChannels(agent.member?.id ?? null, chat.roomId);
  const showSessions = useShowSessions();
  const name = agent.name ?? 'Agent';

  return (
    <OneBar
      identity={
        <div
          className="flex min-w-0 shrink items-center gap-1.5 text-sm"
          data-testid="dm-header-identity"
        >
          {agent.visual && (
            <AgentAvatar
              color={agent.visual.color}
              emoji={agent.visual.emoji}
              size="xs"
              badge={null}
            />
          )}
          <span className="min-w-[3.5rem] shrink truncate font-medium" title={name}>
            {name}
          </span>
          {working ? (
            <span className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-xs">
              <span aria-hidden>·</span>
              <span
                aria-hidden
                className={cn('size-1.5 rounded-full', statusDotClass('working'))}
              />
              Working
            </span>
          ) : agent.role ? (
            <span
              className="text-muted-foreground min-w-0 shrink-[9999] truncate text-xs"
              title={agent.role}
            >
              <span aria-hidden>· </span>
              {agent.role}
            </span>
          ) : null}
        </div>
      }
      actions={
        <>
          <SharedChannelLinks channels={channels} />
          {showSessions && <SessionChip sessionId={sessionId} />}
        </>
      }
    />
  );
}

/**
 * "Also in #design, #launch +2": the channels you share with this agent, each a
 * link to the room. Nothing at all when you share none.
 */
function SharedChannelLinks({ channels }: { channels: readonly SharedChannel[] }) {
  const navigate = useNavigate();
  const { visible, more } = splitSharedChannels(channels);
  if (visible.length === 0) return null;
  const rest = channels.slice(visible.length).map((channel) => channel.label);
  return (
    <span
      className="text-muted-foreground flex min-w-0 items-center gap-1 text-xs @max-md/bar:hidden"
      data-testid="dm-shared-channels"
    >
      <span className="shrink-0">Also in</span>
      {visible.map((channel, index) => (
        <span key={channel.id} className="flex min-w-0 items-center">
          <button
            type="button"
            onClick={() => void navigate({ ...appRoutes.channels(), search: { id: channel.id } })}
            className="focus-ring text-foreground/80 hover:text-foreground max-w-32 truncate rounded-sm underline-offset-4 hover:underline"
          >
            {channel.label}
          </button>
          {index < visible.length - 1 && <span aria-hidden>,</span>}
        </span>
      ))}
      {more > 0 && (
        <span className="shrink-0" title={rest.join(', ')}>
          +{more}
        </span>
      )}
    </span>
  );
}

/**
 * `>_ Session · 64%`: the working session behind this DM, and how full its
 * context is. Opens the session view.
 */
function SessionChip({ sessionId }: { sessionId: string }) {
  const { openSessionView } = useSessionViewLinks();
  const { contextPercent } = useSessionDiagnostics(sessionId);
  const percent = typeof contextPercent === 'number' ? Math.round(contextPercent) : null;
  return (
    <button
      type="button"
      onClick={openSessionView}
      aria-label="Open the session behind this chat"
      data-testid="dm-session-chip"
      className="focus-ring text-muted-foreground hover:bg-accent hover:text-foreground flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors"
    >
      <Terminal className="size-3.5" aria-hidden />
      <span>Session</span>
      {percent !== null && <span className="tabular-nums">· {percent}%</span>}
    </button>
  );
}
