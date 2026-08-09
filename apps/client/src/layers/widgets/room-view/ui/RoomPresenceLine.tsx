import { useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import {
  PRESENCE_NAME_LIMIT,
  presenceCountSentence,
  presenceElapsed,
  presenceListRow,
  presenceSentence,
  useRoomPresence,
  type PresenceScope,
} from '@/layers/entities/room';

/**
 * What to call an agent the roster does not hold.
 *
 * Reachable only in the seconds between an agent joining a room and this
 * client's copy of the roster catching up. Counting it without naming it is the
 * honest answer: something IS working, and this client cannot yet say what.
 */
const UNKNOWN_AGENT = 'An agent';

/** What a presence line needs to know about the room under it. */
interface RoomPresenceLineProps {
  /** The room on screen. */
  roomId: string;
  /** Its roster, which is where the names come from. */
  members: readonly RoomRosterEntry[];
  /**
   * Which half of the room's presence this line speaks for, when a thread panel
   * is open. The panel's line takes the thread's claims and the room's line
   * takes the rest, so one agent's work is announced once. Omit for all of it.
   */
  scope?: PresenceScope;
}

/**
 * The line under the composer that says who is working on it.
 *
 * Absent — not empty, not a placeholder — whenever nobody is. A room where
 * nothing is happening should look like a room where nothing is happening, and
 * a reserved strip of blank space under the composer is a permanent cost paid
 * for an occasional message. The screen-reader announcer beside it stays mounted
 * regardless, which costs no space and is what makes the announcement work.
 *
 * The elapsed time is derived from each claim's own start and ticks on this
 * client's clock, so a turn that runs for ten minutes costs ten minutes of
 * nothing on the wire.
 *
 * @param props - The room and its roster.
 */
export function RoomPresenceLine({ roomId, members, scope }: RoomPresenceLineProps) {
  const working = useRoomPresence(roomId, scope);
  const [expanded, setExpanded] = useState(false);
  const counted = working.length > PRESENCE_NAME_LIMIT;

  // Dropping back to three names takes the button away with it, so the open
  // state has to go too — otherwise going 4 → 3 → 4 reopens a list nobody asked
  // to see. Adjusted during render rather than in an effect: React re-runs this
  // component before committing anything, so the extra pass costs a render, not
  // a flash of the wrong thing.
  if (expanded && !counted) setExpanded(false);

  const nameOf = (authorId: string): string =>
    members.find((member) => member.author.id === authorId)?.author.displayName ?? UNKNOWN_AGENT;

  // The oldest claim's state speaks for the line, whether it names the agents or
  // counts them: it is the claim the elapsed time beside the sentence measures,
  // and the one that crosses the server's late threshold first.
  const oldestState = working[0]?.state ?? 'working';
  // The one sentence, said the same way whether it is on screen or read out.
  const sentence = counted
    ? presenceCountSentence(working.length, oldestState)
    : presenceSentence(
        working.map((agent) => nameOf(agent.authorId)),
        oldestState
      );

  // What a screen reader is told, which is deliberately NOT what is on screen:
  // the elapsed time is left out, because a live region that reworded itself
  // every second would make the room unusable. The sentence changes only when
  // who is working changes, or when the wait goes long.
  const announcement = working.length === 0 ? '' : sentence;

  return (
    <>
      {/* Mounted whether or not anyone is working. A live region that arrives
          with its text already in it is the classic case assistive technology
          does not announce — the region has to be there first, so that the
          sentence lands as a CHANGE to something already being watched. Same
          shape as `ToolApproval`'s announcer. `sr-only` reserves no visual
          space, so the line itself is still absent when nothing is happening. */}
      <span
        // Named for the half of the room it speaks for. With a thread open on a
        // wide screen there are two of these on the page — the panel's and the
        // room's — and one testid over both made "the room announced it"
        // unaskable: the query either found two nodes or silently answered with
        // whichever came first in the document.
        data-testid={
          scope?.inside === true ? 'thread-presence-announcer' : 'room-presence-announcer'
        }
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </span>
      {/* The hand-off (design record §5.4): the line does not vanish, it fades
          as the answer settles upward into the space it leaves — the indicator
          visibly BECOMING the answer. The exit is `motion`'s because an exit is
          the one thing CSS cannot animate on an element that is unmounting; the
          reply's own rise is CSS, in the panel that draws it. */}
      <AnimatePresence initial={false}>
        {working.length > 0 && (
          <motion.div
            key="presence"
            exit={{ opacity: 0 }}
            transition={{ duration: 0.16, ease: [0.3, 1, 0.4, 1] }}
            data-testid={scope?.inside === true ? 'thread-presence' : 'room-presence'}
            className="text-muted-foreground px-4 pb-2 text-xs"
          >
            {counted ? (
              <>
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => setExpanded((open) => !open)}
                  className="focus-ring hover:text-foreground rounded underline underline-offset-2"
                >
                  {sentence}
                </button>
                {expanded && (
                  <ul className="mt-1 space-y-0.5">
                    {/* Every row is an agent. Presence is published only by the
                      dispatcher's claim lifecycle and only agents are claimed,
                      so a person can never appear here — and the copy is written
                      for an agent on purpose (room-presence spec §5.2). If human
                      typing ever ships it gets its own row, not this one. */}
                    {working.map((agent) => (
                      <li key={agent.authorId}>
                        {presenceListRow(
                          nameOf(agent.authorId),
                          agent.state,
                          presenceElapsed(agent.elapsedMs)
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p>
                {`${presenceSentence(
                  working.map((agent) => nameOf(agent.authorId)),
                  working[0]!.state
                )} · ${presenceElapsed(working[0]!.elapsedMs)}`}
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
