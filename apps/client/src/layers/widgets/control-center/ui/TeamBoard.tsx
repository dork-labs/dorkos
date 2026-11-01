import { AnimatePresence, motion } from 'motion/react';
import { AgentAvatar } from '@/layers/entities/agent';
import { cn, toSession } from '@/layers/shared/lib';
import { useAppStore, useNow, useSafeNavigate } from '@/layers/shared/model';
import {
  formatRunningFor,
  teamRowCount,
  type TeamBoardChat,
  type TeamBoardRow,
} from '../model/team-board';
import { useTeamBoard, type TeamBoard as TeamBoardData } from '../model/use-team-board';

/**
 * A line of text that crossfades when it changes. Stacked in one grid cell, so
 * the old and new words share the row and nothing jumps. The app's
 * `MotionConfig reducedMotion="user"` makes the fade instant under reduced motion.
 */
function FadeText({ text, className }: { text: string; className?: string }) {
  return (
    <span className={cn('grid min-w-0', className)}>
      <AnimatePresence initial={false}>
        <motion.span
          key={text}
          className="col-start-1 row-start-1 truncate"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          {text}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function ChatRow({ chat, now, onOpen }: { chat: TeamBoardChat; now: number; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        data-testid="team-chat-row"
        onClick={onOpen}
        aria-label={`${chat.title}: ${chat.activity}. Open.`}
        className="focus-ring hover:bg-accent/60 flex h-11 w-full min-w-0 items-center gap-2 rounded-md pr-2 pl-9 text-left text-xs transition-colors"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate">{chat.title}</span>
          {chat.waiting ? (
            <span className="text-status-warning-fg flex items-center gap-1.5">
              <span className="bg-status-warning-fg size-1.5 shrink-0 rounded-full" aria-hidden />
              Waiting
            </span>
          ) : (
            <FadeText text={chat.activity} className="text-muted-foreground" />
          )}
        </span>
        {chat.startedAt !== null ? (
          <span className="text-muted-foreground shrink-0 tabular-nums">
            {formatRunningFor(now - chat.startedAt)}
          </span>
        ) : null}
      </button>
    </li>
  );
}

function AgentRow({
  row,
  now,
  onOpenChat,
}: {
  row: TeamBoardRow;
  now: number;
  onOpenChat: (chat: TeamBoardChat) => void;
}) {
  return (
    <li data-testid="team-agent-row">
      <div className="flex h-11 min-w-0 items-center gap-2 px-2 text-xs">
        <AgentAvatar color={row.agent.color} emoji={row.agent.emoji} size="xs" badge={null} />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-medium">{row.agent.name}</span>
          <FadeText text={teamRowCount(row)} className="text-muted-foreground" />
        </span>
      </div>
      {row.chats.length > 0 ? (
        <ul className="flex flex-col">
          {row.chats.map((chat) => (
            <ChatRow key={chat.id} chat={chat} now={now} onOpen={() => onOpenChat(chat)} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * The Team view (DOR-3461): who is running, who is waiting on you, and how much
 * room is left. A "now" view, so no charts and no history. Data comes from
 * {@link useTeamBoard}.
 */
export function TeamBoard() {
  const board = useTeamBoard();
  const now = useNow(30_000);
  const navigate = useSafeNavigate();
  const setControlCenterOpen = useAppStore((s) => s.setControlCenterOpen);

  return (
    <TeamBoardView
      board={board}
      now={now}
      onOpenChat={(chat) => {
        setControlCenterOpen(false);
        navigate?.(toSession({ session: chat.id, dir: chat.cwd }));
      }}
    />
  );
}

/**
 * The Team view's rows for a given board, with no data reads of its own, so the
 * Dev Playground can draw every state.
 *
 * @param props - The board, the current time, and what opening a chat does.
 */
export function TeamBoardView({
  board,
  now,
  onOpenChat: openChat,
}: {
  board: TeamBoardData;
  now: number;
  onOpenChat: (chat: TeamBoardChat) => void;
}) {
  return (
    <section className="flex flex-col gap-2" data-testid="control-center-team">
      <p
        data-testid="team-figures"
        className="flex flex-wrap gap-x-1.5 gap-y-0.5 px-1 text-xs tabular-nums"
      >
        {board.figures.map((figure, index) => (
          <span key={figure.key} className="flex gap-1.5">
            <span
              data-over={figure.over || undefined}
              className={cn(figure.over && 'text-status-warning-fg', index === 0 && 'font-medium')}
            >
              {figure.text}
            </span>
            {/* After the figure, so a wrapped line never starts with a dot. */}
            {index < board.figures.length - 1 ? (
              <span className="text-muted-foreground" aria-hidden>
                ·
              </span>
            ) : null}
          </span>
        ))}
      </p>

      {board.atCap ? (
        <p data-testid="team-cap" className="text-status-warning-fg px-1 text-xs">
          New spin-off chats wait until one finishes.
        </p>
      ) : null}

      {board.isEmpty ? (
        <p data-testid="team-empty" className="text-muted-foreground px-1 text-xs">
          Nothing running. Agents start their next item when a slot frees.
        </p>
      ) : (
        <ul className="flex max-h-[60dvh] flex-col overflow-y-auto">
          {board.rows.map((row) => (
            <AgentRow key={row.agent.id} row={row} now={now} onOpenChat={openChat} />
          ))}
          {board.otherChats.length > 0 ? (
            <li data-testid="team-other-chats">
              <p className="text-muted-foreground flex h-11 items-center px-2 text-xs">
                Other chats
              </p>
              <ul className="flex flex-col">
                {board.otherChats.map((chat) => (
                  <ChatRow key={chat.id} chat={chat} now={now} onOpen={() => openChat(chat)} />
                ))}
              </ul>
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
