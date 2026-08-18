/**
 * `Conversation.LivePeek` — what the live lane opens into.
 *
 * The lane holds one truncated sentence; this holds the rest of it. One row per
 * working agent: its face, how long it has been going, what it is answering, and
 * the two things a person watching actually wants — a way into the session, and
 * a way to stop.
 *
 * It draws inside `ResponsivePopover`, which the lane owns, so this is a popover
 * on a desktop and a bottom sheet on a phone with no second implementation.
 *
 * @module features/conversation/ui/LivePeek
 */
import { useEffect, useState } from 'react';
import { ArrowRight } from 'lucide-react';
import { presenceElapsed, type PresenceCopyState } from '@/layers/entities/room';
import type { MessageAuthor } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui';
import { MessageAuthorAvatar } from './message/MessageAuthorAvatar';

/** How often a peek row re-reads the clock. Its own leaf, as in the lane. */
const PEEK_TICK_MS = 1_000;

/** What one working agent looks like in the peek. */
export interface LivePeekRow {
  /** The agent's author id in this conversation — the row's key. */
  authorId: string;
  /** Its face and name, resolved by the host from its own roster. */
  author: MessageAuthor;
  /** Whether the conversation is still waiting for it, or has stopped. */
  state: PresenceCopyState;
  /** ISO 8601 — when its oldest live claim started. */
  since: string;
  /**
   * What it is answering, in the words already on screen, or `null` when the
   * host could not resolve the entry (it has scrolled out of the loaded page).
   */
  replyingTo: { entryId: string; excerpt: string } | null;
  /**
   * Where its work runs, or `null` when this room holds no binding for it.
   *
   * `null` draws NO link rather than a disabled one: a control that cannot do
   * anything is a promise the product is not keeping.
   */
  sessionId: string | null;
}

/** What the peek needs to draw itself. */
export interface LivePeekProps {
  /** One row per working agent, oldest claim first. */
  rows: readonly LivePeekRow[];
  /** Jump the timeline to an entry and flash it. */
  onScrollToRow?: (entryId: string) => void;
  /** Open the session an agent's work runs in. */
  onOpenSession?: (sessionId: string) => void;
  /**
   * Stop everything running here.
   *
   * Absent on a surface that already has its own stop — a session's composer
   * has one, and two buttons for one verb is one too many.
   */
  onStopAll?: () => void;
  /** True while a stop is in flight, so the button can say so. */
  stopping?: boolean;
}

/**
 * The peek.
 *
 * **Stop is the room-wide halt, and the label says so.** A per-agent stop cannot
 * be built honestly yet: `RoomTriggerDispatcher.halt` marks its halted turns
 * before its first `await` precisely to close a two-second race, and it also
 * writes one `halted` notice for the whole room and drops the room's gather
 * buffer — so a per-author version is a room-conduct decision with its own copy
 * and its own review, not a filter on that function. So the button never claims
 * a precision the server does not have:
 *
 * - **One agent working** — a `Stop` on its row. It halts the room, and the room
 *   is that agent.
 * - **Two or more** — no per-row stop at all. One footer action that says
 *   exactly what it will do, with the count.
 *
 * @param props - The rows and the three things a row can do.
 */
export function LivePeek({
  rows,
  onScrollToRow,
  onOpenSession,
  onStopAll,
  stopping = false,
}: LivePeekProps) {
  // The single-agent case is the only one where stopping the room and stopping
  // the agent are the same act.
  const perRowStop = rows.length === 1 && onStopAll !== undefined;
  const footerStop = rows.length > 1 && onStopAll !== undefined;

  return (
    <div data-testid="live-peek" className="flex flex-col">
      <ul className="divide-border divide-y">
        {rows.map((row) => (
          <li key={row.authorId} data-testid="live-peek-row" className="flex gap-2.5 px-3 py-2.5">
            <MessageAuthorAvatar author={row.author} className="mt-0.5 shrink-0" />
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <p className="flex min-w-0 items-center gap-1.5 text-xs">
                <span className="text-foreground truncate font-medium">
                  {row.author.displayName}
                </span>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
                <span className="text-muted-foreground shrink-0">
                  {row.state === 'working_late' ? 'still working' : 'working'}
                </span>
                <span aria-hidden="true" className="text-muted-foreground/50">
                  ·
                </span>
                <PeekElapsed since={row.since} />
              </p>

              {row.replyingTo !== null && onScrollToRow !== undefined && (
                <button
                  type="button"
                  data-testid="live-peek-replying-to"
                  onClick={() => onScrollToRow(row.replyingTo!.entryId)}
                  className="focus-ring text-muted-foreground hover:text-foreground truncate rounded text-left text-xs underline underline-offset-2"
                >
                  {`Replying to “${row.replyingTo.excerpt}”`}
                </button>
              )}

              <div className="mt-0.5 flex items-center gap-2">
                {/* Absent, never disabled, when nothing is bound. */}
                {row.sessionId !== null && onOpenSession !== undefined && (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    data-testid="live-peek-open-session"
                    onClick={() => onOpenSession(row.sessionId!)}
                    className="h-7 gap-1 px-2 text-xs"
                  >
                    Open its session
                    <ArrowRight aria-hidden="true" className="size-3" />
                  </Button>
                )}
                {perRowStop && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-testid="live-peek-stop"
                    disabled={stopping}
                    onClick={onStopAll}
                    className="h-7 px-2 text-xs"
                  >
                    Stop
                  </Button>
                )}
              </div>
            </div>
          </li>
        ))}
      </ul>

      {footerStop && (
        <div className="border-border border-t p-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            data-testid="live-peek-stop-all"
            disabled={stopping}
            onClick={onStopAll}
            className="h-auto w-full flex-col items-start gap-0.5 px-2 py-1.5 text-xs"
          >
            <span>Stop everything in this room</span>
            {/* The count is the honesty: this button does not stop one agent,
                and a person about to press it should know how many it does. */}
            <span className="text-muted-foreground font-normal">{`Stops all ${rows.length}`}</span>
          </Button>
        </div>
      )}
    </div>
  );
}

/**
 * How long one agent has been going — the peek's own ticking leaf.
 *
 * No ten-second floor here, unlike the lane's: the lane is glanced at and a
 * number that starts at zero is noise there, while the peek is opened on
 * purpose to ask exactly this.
 *
 * @internal
 */
function PeekElapsed({ since }: { since: string }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), PEEK_TICK_MS);
    return () => clearInterval(timer);
  }, [since]);

  return (
    <span className="text-muted-foreground shrink-0 tabular-nums">
      {presenceElapsed(Math.max(0, now - Date.parse(since)))}
    </span>
  );
}
