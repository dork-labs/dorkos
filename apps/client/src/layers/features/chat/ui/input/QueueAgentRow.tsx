import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/layers/shared/ui';
import type { QueueItem } from '../../model/use-message-queue';
import type { AgentQueueActions } from '../../model/messaging/use-agent-queue-actions';
import { UNKNOWN_SENDER } from '../../lib/queue-sender';
import { QueueSenderLine } from './QueueSenderLine';

/** Past this many characters a one-line message still gets "Show all". */
const LONG_LINE = 140;

interface QueueAgentRowProps {
  /** The queued message, sent by another agent's chat. */
  item: QueueItem;
  /** Its place in the queue, from 0. */
  index: number;
  /** Send now and Don't deliver. */
  actions: AgentQueueActions;
  /** Run a message held for the agent's background work anyway, ending that work. */
  onSwitchNow?: (() => void) | undefined;
  /** Called as Send now or Don't deliver starts, so the queue can keep focus if the row leaves. */
  onLeaving?: ((id: string) => void) | undefined;
  /** Why this message waits while its agent is paused. */
  pausedLine?: string | undefined;
}

/**
 * A queued message another agent sent (DOR-3060; designer spec): a quiet tinted
 * row with the sender's face, name and chat, then its summary or first words.
 *
 * It has exactly two actions, always visible: **Send now** joins the running
 * turn (or moves it first when it may not), and **Don't deliver** asks inline
 * before taking it off, because the sender is told. No edit and no reorder:
 * the words are the other agent's. They render as plain text, never markdown,
 * so a crafted summary cannot pass for a DorkOS notice.
 *
 * Every control is a real button in the Tab order. Escape in the confirm
 * keeps the message and hands focus back to Don't deliver.
 */
export function QueueAgentRow({
  item,
  index,
  actions,
  onSwitchNow,
  onLeaving,
  pausedLine,
}: QueueAgentRowProps) {
  const [confirming, setConfirming] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const keepRef = useRef<HTMLButtonElement>(null);
  const askRef = useRef<HTMLButtonElement>(null);
  // Focus moves only after a person opened or closed the confirm, never on mount.
  const movedFocus = useRef(false);
  const fullId = useId();
  const sender = item.sender ?? null;
  const name = sender?.agentName ?? UNKNOWN_SENDER;
  const lead = sender?.summary ?? item.content.split('\n').find((line) => line.trim()) ?? '';
  const hasMore =
    sender?.summary !== undefined || item.content.trim() !== lead || lead.length > LONG_LINE;
  const notice = actions.notices[item.id] ?? item.notice;

  useEffect(() => {
    if (!movedFocus.current) return;
    (confirming ? keepRef : askRef).current?.focus();
  }, [confirming]);

  const ask = () => {
    movedFocus.current = true;
    setConfirming(true);
  };
  const keep = () => {
    movedFocus.current = true;
    setConfirming(false);
  };
  const keepOnEscape = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    keep();
  };

  return (
    <div
      role="group"
      aria-label={`Queued message from ${name}${sender?.chatTitle ? `, from ${sender.chatTitle}` : ''}`}
      className="bg-accent/55 hover:bg-accent focus-within:bg-accent flex flex-wrap items-start gap-x-2 gap-y-1 rounded-lg py-1.5 pr-2 pl-2.5 transition-colors"
    >
      <span className="text-muted-foreground shrink-0 pt-px text-xs font-medium">{index + 1}.</span>
      <div className="min-w-0 flex-1 basis-56">
        <QueueSenderLine sender={sender} />
        {expanded ? (
          <div
            id={fullId}
            className="text-foreground mt-0.5 max-h-72 overflow-y-auto text-sm break-words whitespace-pre-wrap"
          >
            {item.content}
          </div>
        ) : (
          <p className="text-foreground mt-0.5 line-clamp-2 text-sm break-words">{lead}</p>
        )}
        {hasMore && (
          <button
            type="button"
            aria-expanded={expanded}
            aria-controls={expanded ? fullId : undefined}
            onClick={() => setExpanded((open) => !open)}
            className="focus-ring text-muted-foreground hover:text-foreground focus-visible:text-foreground rounded-sm text-xs underline-offset-4 hover:underline focus-visible:underline"
          >
            {expanded ? 'Show less' : 'Show all'}
          </button>
        )}
        {notice !== null && <p className="text-muted-foreground line-clamp-1 text-xs">{notice}</p>}
        {item.waiting !== undefined && (
          <p className="text-muted-foreground line-clamp-1 text-xs">{item.waiting.line}</p>
        )}
        {pausedLine !== undefined && (
          <p className="text-muted-foreground text-xs">{pausedLine}</p>
        )}
      </div>
      {confirming ? (
        <div className="ml-auto flex basis-full flex-wrap items-center justify-end gap-1 text-xs sm:basis-auto">
          <span className="text-foreground">
            {sender === null
              ? 'Don’t deliver? The chat that sent it will be told.'
              : `Don’t deliver? ${name}’s chat will say it wasn’t delivered.`}
          </span>
          <Button
            ref={keepRef}
            variant="ghost"
            size="xs"
            responsive={false}
            onClick={keep}
            onKeyDown={keepOnEscape}
          >
            Keep
          </Button>
          <Button
            variant="ghost"
            size="xs"
            responsive={false}
            className="text-destructive hover:text-destructive"
            onKeyDown={keepOnEscape}
            onClick={() => {
              setConfirming(false);
              onLeaving?.(item.id);
              actions.dontDeliver(item.id, sender === null ? null : name);
            }}
          >
            Don’t deliver
          </Button>
        </div>
      ) : (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Held for the agent's background work, as a person's row can be. */}
          {item.waiting !== undefined && onSwitchNow !== undefined && (
            <Button
              variant="ghost"
              size="xs"
              responsive={false}
              title={item.waiting.switchHint}
              onClick={onSwitchNow}
            >
              Switch now
            </Button>
          )}
          <Button
            variant="ghost"
            size="xs"
            responsive={false}
            loading={actions.sending.has(item.id)}
            loadingLabel="Sending…"
            onClick={() => {
              onLeaving?.(item.id);
              actions.sendNow(item.id);
            }}
          >
            Send now
          </Button>
          <Button
            variant="ghost"
            size="xs"
            responsive={false}
            ref={askRef}
            className="text-muted-foreground"
            onClick={ask}
          >
            Don’t deliver
          </Button>
        </div>
      )}
    </div>
  );
}
