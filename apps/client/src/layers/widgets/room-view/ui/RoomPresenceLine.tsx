import { useState } from 'react';
import type { RoomRosterEntry } from '@dorkos/shared/room-schemas';
import { presenceElapsed, useRoomPresence } from '@/layers/entities/room';
import { PRESENCE_NAME_LIMIT, presenceSentence } from '../lib/presence-copy';

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
export function RoomPresenceLine({ roomId, members }: RoomPresenceLineProps) {
  const working = useRoomPresence(roomId);
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

  // What a screen reader is told, which is deliberately NOT what is on screen:
  // the elapsed time is left out, because a live region that reworded itself
  // every second would make the room unusable. The sentence changes only when
  // who is working changes, or when the wait goes long.
  const announcement =
    working.length === 0
      ? ''
      : counted
        ? `${working.length} agents are working on it`
        : presenceSentence(
            working.map((agent) => nameOf(agent.authorId)),
            working[0]!.state
          );

  return (
    <>
      {/* Mounted whether or not anyone is working. A live region that arrives
          with its text already in it is the classic case assistive technology
          does not announce — the region has to be there first, so that the
          sentence lands as a CHANGE to something already being watched. Same
          shape as `ToolApproval`'s announcer. `sr-only` reserves no visual
          space, so the line itself is still absent when nothing is happening. */}
      <span
        data-testid="room-presence-announcer"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="sr-only"
      >
        {announcement}
      </span>
      {working.length > 0 && (
        <div data-testid="room-presence" className="text-muted-foreground px-4 pb-2 text-xs">
          {counted ? (
            <>
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((open) => !open)}
                className="focus-ring hover:text-foreground rounded underline underline-offset-2"
              >
                {working.length} agents are working on it
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
                      {`${nameOf(agent.authorId)} · ${presenceElapsed(agent.elapsedMs)}`}
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
        </div>
      )}
    </>
  );
}
