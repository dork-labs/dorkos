/**
 * The room speaking about ITSELF — one quiet full-width line with a mark on it.
 *
 * The other half of `RoomEntryRow`'s job, and the half that shares almost
 * nothing with it: a notice has no author beside it, no actions, and no thread,
 * so the grid, the toolbar and the reactions the row builds for a post are all
 * dead weight here. The row still decides WHICH of the two an entry is; this
 * module owns everything that follows from the answer being "notice", including
 * the table that tells sixteen codes apart at a glance.
 *
 * @module widgets/room-view/ui/RoomNoticeRow
 */
import {
  CircleSlash,
  CircleStop,
  Gauge,
  Hand,
  History,
  Hourglass,
  Info,
  Link2Off,
  Megaphone,
  RefreshCw,
  Repeat,
  Timer,
  TriangleAlert,
  Unplug,
  UserMinus,
  UserX,
  WifiOff,
  type LucideIcon,
} from 'lucide-react';
import type { RoomNoticeCode } from '@dorkos/shared/room-schemas';
import { feedArticleProps, type FeedPosition } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import type { RoomEntry } from '@/layers/entities/room';

interface RoomNoticeRowProps {
  /** The notice to draw — its own words, and the code that chooses its mark. */
  entry: RoomEntry;
  /**
   * Where this row sits in the feed it is rendering inside, or omitted where it
   * renders outside a feed entirely — see `RoomEntryRow`, which owns the rule.
   */
  feedPosition?: FeedPosition;
  /** The DOM id to put on the row, when something has to be able to find it again. */
  rowId?: string;
}

/**
 * How each kind of notice is drawn.
 *
 * The room speaks in its own voice about several different things and used to
 * draw them all identically — one italic muted line, with `body.notice` read by
 * nothing anywhere in the client. So "your agent hit an error and could not
 * answer" looked exactly like "this room widened who answers here", and a
 * reader skimming had no way to tell a problem from an aside without reading
 * every line in full.
 *
 * A mark each, and a tone for the ones that need one. **Warm is reserved for a
 * line that wants the reader to DO something** — `turn_failed` and
 * `bridge_undelivered`, where an answer or a message is not coming;
 * `awaiting_approval`, where the agent has stopped and cannot go on until
 * somebody answers it; `agent_gone` and `bridge_blocked`, where nothing
 * happens again until the reader re-registers an agent or flips a switch.
 * Everything else is the room working as designed and saying so, and a column
 * of amber over a busy afternoon would teach a reader to stop looking. The
 * mark is what tells them apart at a glance; the colour is what says one of
 * them is waiting on you.
 *
 * The WORDS are never touched here. The server owns them (`room-notices.ts`)
 * and writes them for a person who did not configure this room; a second
 * sentence invented at the render would be a second voice saying the same thing
 * slightly differently.
 */
const NOTICE_STYLES: Record<RoomNoticeCode, { Icon: LucideIcon; tone?: string }> = {
  // Something went wrong and the answer is not coming.
  turn_failed: { Icon: TriangleAlert, tone: 'text-status-warning' },
  // Occupied, not broken — and the message has to be sent again.
  agent_busy: { Icon: Hourglass },
  // The agent is not installed here any more, so no answer is coming until
  // somebody re-registers it. Warm for the same reason `turn_failed` is: this
  // one is waiting on the reader, and waiting longer will not help.
  agent_gone: { Icon: UserX, tone: 'text-status-warning' },
  // The agent could not be readied to answer — almost always brief database
  // contention that clears on its own by the next message, which is why it
  // reads like `agent_busy` rather than `turn_failed`: occupied, not broken.
  agent_unavailable: { Icon: RefreshCw },
  // Stopped, and waiting for THIS reader to do something about it. Warm like
  // `turn_failed`, and for the same reason: both are lines a person has to act
  // on, and the rest are the room reporting that it is working as designed.
  awaiting_approval: { Icon: Hand, tone: 'text-status-warning' },
  // Somebody stopped everything here, on purpose.
  halted: { Icon: CircleStop },
  // A cap was reached. Nothing is wrong; the room is doing what it was told.
  budget_reached: { Icon: Gauge },
  // A back-and-forth reached its depth and stopped itself.
  cascade_stopped: { Icon: CircleSlash },
  // DorkOS changed when the agents here answer, and has to admit it.
  addressing_changed: { Icon: Megaphone },
  // A bridge delivery was refused by a consent switch, or by a provenance
  // misclassification after a restart. Warm: the switch is something a person
  // can go flip.
  bridge_blocked: { Icon: Unplug, tone: 'text-status-warning' },
  // A bridge delivery exhausted its retry budget. Warm for the same reason
  // `turn_failed` is: the message did not reach the chat and nothing here will
  // retry it further.
  bridge_undelivered: { Icon: WifiOff, tone: 'text-status-warning' },
  // An inbound rate ceiling refused a message. The room is protecting itself
  // as designed, not broken.
  bridge_rate_limited: { Icon: Timer },
  // A second agent was refused on a bridged room — the room protecting its
  // one-agent-per-binding consent model (D-6 Q3), not a malfunction.
  bridge_second_agent_refused: { Icon: UserMinus },
  // The bridge was switched off and the room archived — the chat is no longer
  // connected. Not warm: this is the room reporting a state a person chose (or
  // the platform forced), the last line before it goes quiet on purpose.
  bridge_disconnected: { Icon: Link2Off },
  // A re-bridge handed the chat to a different agent. The room working as
  // designed — nobody has to act — so it stays quiet in tone.
  bridge_agent_swapped: { Icon: Repeat },
  // Where the conversation's earlier history lives, posted once when a chat is
  // bridged (chats-as-channels §7.3). Informational, never a fault, so it stays
  // quiet in tone.
  bridge_history_note: { Icon: History },
};

/** The mark on a notice whose code this client does not recognise. */
const UNKNOWN_NOTICE: { Icon: LucideIcon; tone?: string } = { Icon: Info };

/** How much of a notice its name carries before it is cut short. */
const NOTICE_NAME_MAX = 80;

/**
 * A notice's own words, short enough to be a name.
 *
 * Cut on a word boundary where there is one within reach, so the name ends
 * mid-sentence rather than mid-word — a name is spoken, and a chopped word is
 * heard as a mistake.
 *
 * @param text - What the notice says.
 */
function noticeName(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= NOTICE_NAME_MAX) return trimmed;
  const cut = trimmed.slice(0, NOTICE_NAME_MAX);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > NOTICE_NAME_MAX / 2 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * One line of the room talking about itself.
 *
 * It renders as a quiet full-width line with no author beside it: attributing
 * "Ana stopped replying here" to a person would be a lie about who said it. It
 * also carries no actions — there is no author to mention, and nobody said it
 * to answer.
 *
 * An article like any other line of the log, and a stop the feed can land on.
 * Leaving it out of the set would make Page Down skip the room saying something
 * about itself — which is exactly the kind of line a reader who is not watching
 * the screen most needs to be given.
 *
 * Named from its OWN words, not a fixed "Room notice". An `aria-label`
 * REPLACES the element's text for naming purposes, so a shared label over a
 * one-line paragraph is a live hazard: land on it and the only thing guaranteed
 * to be announced is the label, which would turn "Ana stopped replying here"
 * into three words that say nothing. Naming it after its own text means the
 * worst case is hearing the line twice rather than never.
 */
export function RoomNoticeRow({ entry, feedPosition, rowId }: RoomNoticeRowProps) {
  const { Icon, tone } = (entry.body.notice && NOTICE_STYLES[entry.body.notice]) ?? UNKNOWN_NOTICE;

  return (
    <p
      // Addressable like any other row. A notice heads no thread today, so
      // nothing looks it up — but "which rows can be found again" must not
      // quietly become "the rows somebody remembered to pass an id to", and a
      // room's focus restore looks up entry ids, not entry kinds.
      id={rowId}
      data-testid="room-notice"
      data-notice={entry.body.notice ?? 'unknown'}
      {...(feedPosition && { role: 'article', 'aria-label': noticeName(entry.body.text) })}
      {...feedArticleProps(feedPosition)}
      className={cn(
        'focus-visible:ring-ring/50 flex items-start gap-2 px-[var(--msg-padding-x)] py-2 text-xs outline-none focus-visible:ring-2',
        tone ?? 'text-muted-foreground'
      )}
    >
      {/* Decoration, and it has to stay decoration: the words beside it already
          say everything the mark stands for, and naming the icon would make a
          screen reader read "warning" before a sentence that goes on to
          explain itself. */}
      <Icon aria-hidden className="mt-px size-3.5 shrink-0" />
      <span>{entry.body.text}</span>
    </p>
  );
}
