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
import { useEffect, useRef, useState } from 'react';
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
   * What it is answering — the words already on screen, and the DOM id of the
   * row they are on — or `null` when the host cannot honestly offer either.
   *
   * **`rowId`, not `entryId`, is what makes the link real.** An entry can be
   * quotable and still be drawn nowhere (a reply lives in a thread panel, and a
   * phone unmounts the room while one is open), and a link that scrolls to
   * nothing is worse than no link. The host resolves the element; this draws the
   * control only when there is one.
   */
  replyingTo: { entryId: string; excerpt: string; rowId: string } | null;
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
  /** Take the reader to a row by its DOM id, and leave them standing on it. */
  onScrollToRow?: (rowId: string) => void;
  /** Open the session an agent's work runs in. */
  onOpenSession?: (sessionId: string) => void;
  /**
   * Stop everything running here.
   *
   * Absent on a surface that already has its own stop — a session's composer
   * has one, and two buttons for one verb is one too many.
   */
  onStopAll?: () => void;
  /** True while the room-wide stop is in flight, so its button can say so. */
  stopping?: boolean;
  /**
   * Stop one agent, leaving the rest of the room working.
   *
   * Absent on a surface with no per-agent stop behind it, which draws no row
   * button at all rather than a disabled one.
   */
  onStopAgent?: (authorId: string) => void;
  /** Author ids with a stop in flight, so their row buttons can say so. */
  stoppingAgents?: ReadonlySet<string>;
}

/**
 * The peek.
 *
 * **Two stops, and the difference is the scope, not the verb.** A row's Stop
 * ends that agent's turn here and leaves everybody else working. The footer's
 * ends everything in the room and says how many that is. Both reach the runtimes
 * through the room's own halt path, which marks the stopped dispatch before it
 * does anything that can yield, so a turn that streams its last words after the
 * interrupt has them thrown away.
 *
 * Every row gets a Stop, whatever state it is in — a person should not have to
 * know which internal state a row is in to know what its button does — and the
 * footer earns its place only when there IS something else for it to stop.
 *
 * **Pressing a row's Stop removes that row**, because the agent stops working
 * and the peek draws working agents, so this also owns the focus that leaves
 * with it — see the effect below.
 *
 * @param props - The rows and the four things a peek can do.
 */
export function LivePeek({
  rows,
  onScrollToRow,
  onOpenSession,
  onStopAll,
  stopping = false,
  onStopAgent,
  stoppingAgents,
}: LivePeekProps) {
  const perRowStop = onStopAgent !== undefined;
  // The footer is the "and everything else" action, so it earns its place only
  // when there IS something else.
  const footerStop = rows.length > 1 && onStopAll !== undefined;
  const stopButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusedRow = useRef<string | null>(null);
  const drawnRows = useRef<readonly LivePeekRow[]>(rows);

  // **Pressing Stop makes the row you pressed it on disappear**, and with it the
  // button holding focus — the peek stays open, so a keyboard reader is left
  // standing on `document.body` inside a popover they can no longer move
  // through. Hand focus to the row that took its place instead.
  //
  // Guarded on focus having ACTUALLY been lost: somebody who pressed Stop and
  // then tabbed to another row has moved on, and stealing it back would be worse
  // than the thing this fixes.
  useEffect(() => {
    const before = drawnRows.current;
    drawnRows.current = rows;
    const gone = focusedRow.current;
    if (gone === null || rows.some((row) => row.authorId === gone)) return;
    focusedRow.current = null;
    if (document.activeElement !== document.body) return;
    const wasAt = before.findIndex((row) => row.authorId === gone);
    const heir = rows[Math.min(Math.max(wasAt, 0), rows.length - 1)];
    if (heir !== undefined) stopButtons.current.get(heir.authorId)?.focus();
  }, [rows]);

  return (
    <div data-slot="live-peek" data-testid="live-peek" className="flex flex-col">
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
                  onClick={() => onScrollToRow(row.replyingTo!.rowId)}
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
                    disabled={stoppingAgents?.has(row.authorId) === true}
                    onClick={() => onStopAgent(row.authorId)}
                    onFocus={() => (focusedRow.current = row.authorId)}
                    ref={(node) => {
                      if (node === null) stopButtons.current.delete(row.authorId);
                      else stopButtons.current.set(row.authorId, node);
                    }}
                    // Several of these can be on screen at once, so the visible
                    // word is not enough to say which agent a button stops.
                    aria-label={`Stop ${row.author.displayName}`}
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
