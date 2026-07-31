import { useEffect, useMemo, useRef, type KeyboardEvent } from 'react';
import { ChevronLeft, X } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Skeleton } from '@/layers/shared/ui';
import type { RoomEntry, RoomWithRoster } from '@/layers/entities/room';
import { roomDisplayTitle, threadRootIdOf, useRoomPresence } from '@/layers/entities/room';
import { authorsById, toMessageAuthor } from '../lib/room-timeline';
import { useThreadArrivals } from '../model/use-thread-arrivals';
import { RoomComposer } from './RoomComposer';
import { RoomEntryRow } from './RoomEntryRow';
import { RoomPresenceLine } from './RoomPresenceLine';

interface RoomThreadPanelProps {
  /** The room the thread lives in. */
  room: RoomWithRoster;
  /** The entry heading the open thread. */
  rootEntryId: string;
  /**
   * True when the reader opened this to write. The composer takes the caret;
   * otherwise the panel takes it, so Escape closes without a click first.
   */
  focusComposer: boolean;
  /**
   * The room's whole history, oldest first. The panel finds its own root and
   * replies in here rather than being handed them, so a reply arriving on the
   * stream reaches it by the same path everything else does.
   */
  entries: RoomEntry[];
  /** This reader's three most-used emoji, as the room read resolved them. */
  reactionFrequents: readonly string[];
  /** True when the room's live stream has given up. */
  streamStalled?: boolean;
  /**
   * Whether the room's history has actually arrived.
   *
   * Two things depend on telling "loading" apart from "empty": a thread whose
   * root has not loaded yet is not an orphaned thread, and a reply that was
   * always there is not an arrival.
   */
  historyLoaded: boolean;
  /** True when this is the mobile full-screen push rather than the side panel. */
  pushed: boolean;
  /** Close the panel. */
  onClose: () => void;
}

/**
 * One thread, with its own composer, beside the room.
 *
 * **The operator chose this over the inline gathering** (design record §3), and
 * the reason is the room's scroll: replies drawn in the flow make the timeline
 * belong to whichever thread is longest, and a room stops reading as a room.
 * Here the room shows a room, and the thread has a place — so a forty-reply
 * aside costs the conversation it hangs off exactly one quiet line.
 *
 * Root at the top with its own reactions, replies beneath it on a connector.
 * Each reply is an ordinary {@link RoomEntryRow}, so it carries the same
 * capsule, the same reactions and the same keyboard model it would anywhere
 * else — a thread is a different PLACE, not a different kind of message.
 *
 * **Presence follows you in** (design record §3.2): an agent working on
 * something inside this thread is announced here rather than under the room's
 * composer, and `PresenceScope` explains why the two lines are complements
 * rather than copies.
 *
 * Three ways out, because the panel is a mode and a mode needs an unmissable
 * exit: the close button, Escape, and clicking another thread's reply row
 * (which switches rather than stacking). On a phone it is a full-screen push
 * and the button becomes Back, naming the room it returns to.
 */
export function RoomThreadPanel({
  room,
  rootEntryId,
  focusComposer,
  entries,
  reactionFrequents,
  streamStalled,
  historyLoaded,
  pushed,
  onClose,
}: RoomThreadPanelProps) {
  const authors = useMemo(() => authorsById(room.members), [room.members]);
  const authorNames = useMemo(
    () => new Map([...authors].map(([id, author]) => [id, author.displayName])),
    [authors]
  );

  const { root, replies } = useMemo(() => {
    let found: RoomEntry | undefined;
    const gathered: RoomEntry[] = [];
    for (const entry of entries) {
      if (entry.id === rootEntryId) found = entry;
      else if (threadRootIdOf(entry) === rootEntryId) gathered.push(entry);
    }
    return { root: found, replies: gathered };
  }, [entries, rootEntryId]);

  // Scoped to the REPLIES, never the root — `PresenceScope` says why an agent
  // triggered by the root is the room's business and not this thread's.
  const replyIds = useMemo(() => new Set(replies.map((reply) => reply.id)), [replies]);
  const working = useRoomPresence(room.id, { replyIds, inside: true });
  const arrivals = useThreadArrivals(
    replies,
    useMemo(() => working.map((agent) => agent.authorId), [working]),
    historyLoaded
  );

  // Follow the thread down as replies land, the way the room's own scroll does.
  // Written as a scroll offset rather than `scrollIntoView` for the same reason
  // `useStickToBottom` is: the offset is the thing actually being asked for, and
  // it needs no layout API beyond the one every scroller already has.
  const scrollRef = useRef<HTMLDivElement>(null);

  /**
   * The panel takes focus when its composer is not going to.
   *
   * Not politeness: Escape is one of the three ways out, and a keydown only
   * reaches the handler below if focus is INSIDE the panel. Opening a thread
   * from a reply row leaves focus on that row, up in the timeline — so without
   * this, the panel could be opened by keyboard and not closed by one.
   */
  const panelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!focusComposer) panelRef.current?.focus();
  }, [rootEntryId, focusComposer]);
  useEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
  }, [replies.length]);

  /**
   * Escape closes, from anywhere inside the panel.
   *
   * On the container rather than on `window`: a global listener would fight
   * every other Escape the panel contains — the mention palette dismisses on
   * it, and the composer's double-Escape clears a draft — and closing the whole
   * thread because somebody dismissed an autocomplete is the wrong outcome
   * every time. Handled only when nothing inside has already taken it.
   */
  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.key !== 'Escape' || event.defaultPrevented) return;
    event.stopPropagation();
    onClose();
  };

  return (
    /*
      A panel is a region, not a control: it holds the thread's messages and
      their own buttons, and none of that may sit inside an interactive
      element. But Escape is one of its three ways out, and a key only reaches
      it if this element hears one — so it is focusable (`tabIndex={-1}`, taken
      on open) and listens, without pretending to be a button. Same shape as
      `RoomEntryRow`, which carries the identical carve-out for the identical
      reason.
    */
    // eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- see above
    <section
      ref={panelRef}
      aria-label="Thread"
      data-testid="room-thread-panel"
      // Focusable but not tabbable: it is a destination for the focus the panel
      // takes on open, never an extra stop on the way to the composer.
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      className={cn(
        'bg-card flex min-h-0 flex-col outline-none',
        // The push IS the room on a phone — it takes the whole surface, with a
        // Back button where the header's close would be. The side panel is a
        // column beside it, bounded so a long thread cannot squeeze the room
        // out of its own screen.
        pushed ? 'h-full w-full' : 'w-full max-w-md min-w-80 basis-2/5 border-l'
      )}
    >
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <button
          type="button"
          onClick={onClose}
          aria-label={pushed ? `Back to ${roomDisplayTitle(room)}` : 'Close thread'}
          className="focus-ring text-muted-foreground hover:text-foreground -ml-1 rounded p-1"
        >
          {pushed ? (
            <ChevronLeft aria-hidden className="size-4" />
          ) : (
            <X aria-hidden className="size-4" />
          )}
        </button>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">Thread</p>
          <p className="text-muted-foreground truncate text-xs">{roomDisplayTitle(room)}</p>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto py-3">
        {root === undefined && !historyLoaded ? (
          // Still arriving. A thread whose root has not loaded YET is not a
          // thread whose root is gone, and saying the second while the first is
          // true flashes a small lie on every deep link.
          <div className="flex flex-col gap-2 px-[var(--msg-padding-x)]" aria-busy>
            <Skeleton className="h-3 w-24" />
            <Skeleton className="h-3 w-full max-w-sm" />
          </div>
        ) : root === undefined ? (
          // The orphaned thread (design record §4). Its replies are real and
          // stay; only the message they answer is out of the loaded history.
          // Saying so beats an empty panel, and beats pretending the first
          // reply is the start of something.
          <p
            data-testid="room-thread-orphan"
            className="text-muted-foreground border-b px-[var(--msg-padding-x)] pb-3 text-xs italic"
          >
            The start of this thread is gone. What was said after it is still here.
          </p>
        ) : (
          <RoomEntryRow
            roomId={room.id}
            entry={root}
            author={toMessageAuthor(root.authorId, authors)}
            authorRef={authors.get(root.authorId)}
            viewerAuthorId={room.viewerAuthorId}
            authorNames={authorNames}
            reactionFrequents={reactionFrequents}
            streamStalled={streamStalled}
            grouping={{ position: 'only' }}
          />
        )}

        {/* No empty state under the root, and that is the decision (design
            record §4): a thread with no replies yet is a root and a composer,
            which is exactly what it is. A drawing of a speech bubble saying "no
            replies yet" would be furniture explaining something already
            obvious. */}
        {replies.length > 0 && (
          <div className="mt-2 flex flex-col">
            {replies.map((reply) => {
              const arrival = arrivals.get(reply.id) ?? 'at-rest';
              return (
                <div key={reply.id} className="relative flex">
                  {/* The connector. It draws downward as a reply lands
                      (design record §5.3) and is otherwise simply there. */}
                  <span
                    aria-hidden
                    data-testid="room-thread-connector"
                    className={cn(
                      'bg-border ml-[calc(var(--msg-padding-x)_+_var(--msg-gutter-width)_/_2)] w-px shrink-0',
                      arrival === 'dropped' && 'motion-safe:animate-thread-line-draw'
                    )}
                  />
                  <div
                    className={cn(
                      'min-w-0 flex-1',
                      // Two arrivals, two motions, and the difference is real:
                      // an ordinary reply drops in from above with a bounce; an
                      // answer from an agent that was just on the presence line
                      // rises into the space that line is leaving.
                      arrival === 'dropped' && 'motion-safe:animate-thread-reply-in',
                      arrival === 'handed-off' && 'motion-safe:animate-reply-settle'
                    )}
                  >
                    <RoomEntryRow
                      roomId={room.id}
                      entry={reply}
                      author={toMessageAuthor(reply.authorId, authors)}
                      authorRef={authors.get(reply.authorId)}
                      viewerAuthorId={room.viewerAuthorId}
                      authorNames={authorNames}
                      reactionFrequents={reactionFrequents}
                      streamStalled={streamStalled}
                      grouping={{ position: 'only' }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Writes into THIS thread because it is mounted here — no aim, no
          banner. `key` on the thread so opening another one gives you a box
          freshly sized for its own draft rather than the last thread's. */}
      <RoomComposer
        key={rootEntryId}
        room={room}
        threadRootId={rootEntryId}
        focusOnMount={focusComposer}
      />

      {/* Under the composer, where the room puts its own — it is about what
          happens after you press Enter. */}
      <RoomPresenceLine
        roomId={room.id}
        members={room.members}
        scope={{ replyIds, inside: true }}
      />
    </section>
  );
}
