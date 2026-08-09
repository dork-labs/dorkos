/**
 * A milestone in the feed — the third thing a room row can be
 * (team-room-home spec D5.1).
 *
 * A moment is a POST: the same entry shape, on the same log, carrying
 * `body.moment` to say what it marks and what it was read off. So this file
 * owns only what follows from a row being one — the calm band it draws in, the
 * identity it draws BESIDE the words, and the one mark the whole family shares.
 * `RoomEntryRow` still decides which of the three kinds of line an entry is.
 *
 * **Warm, and quiet about it.** The only colour on the row is the identity's
 * own, carried by the disc; the band itself is the same muted surface every
 * other quiet thing in the cockpit uses. No brand orange (it means interaction,
 * and there is nothing here to press), no burst, no confetti. There is also no
 * animation at all, which is the honest way to respect reduced motion: a
 * milestone that arrives in a feed a person is reading should not move the
 * words under their eyes.
 *
 * @module widgets/room-view/ui/RoomMomentRow
 */
import { icons } from '@dorkos/icons/registry';
import type { RoomMoment } from '@dorkos/shared/room-schemas';
import { feedArticleProps, type FeedPosition } from '@/layers/shared/model';
import type { MessageAuthor } from '@/layers/shared/model';
import { IdentityHoverCard } from '@/layers/shared/ui';
import type { RoomEntry } from '@/layers/entities/room';
import { MessageAuthorAvatar } from '@/layers/features/chat';
import { formatAbsoluteTime, formatTime } from '../lib/entry-time';
import { toMessageAuthor, type RosterAuthor } from '../lib/room-timeline';
import { useAgentInfo } from '../model/agent-info-context';

/** The one mark every moment carries — see `@dorkos/icons` for why there is only one. */
const MomentMark = icons.moment;

interface RoomMomentRowProps {
  /** The entry, whose `body.moment` made it one. */
  entry: RoomEntry;
  /** That moment, already read off the body by the row that dispatched here. */
  moment: RoomMoment;
  /** Who WROTE it, resolved from the roster — DorkOS itself, or the agent that minted it. */
  author: MessageAuthor;
  /**
   * The room's whole roster, keyed by author id — how `body.subjectAuthorId`
   * resolves to the identity the milestone is about.
   */
  authors: ReadonlyMap<string, RosterAuthor>;
  /**
   * Where this row sits in the feed it is rendering inside, or omitted where it
   * renders outside a feed entirely — see `RoomEntryRow`, which owns the rule.
   */
  feedPosition?: FeedPosition;
  /** The DOM id to put on the row, when something has to be able to find it again. */
  rowId?: string;
}

/**
 * One line marking something that really happened.
 *
 * **The identity is the one the moment is ABOUT.** "tangerines joined your
 * team" is written by DorkOS and is about tangerines, and `body.subjectAuthorId`
 * is what says so — the same field a notice already uses for the same reason.
 * Drawing the writer's face there would make every milestone read as a system
 * message instead of a member's arrival. An agent-minted moment names no
 * subject (the server refuses one on that path), so it falls back to its author,
 * which is exactly who it is about.
 *
 * **Named as a moment, and then in its own words.** A row that only read out
 * its sentence would be heard as somebody talking; `Moment: …` in front of it is
 * the one piece of context a reader who cannot see the band is missing. The
 * words themselves stay in the name rather than being replaced by a fixed label,
 * so the worst case is hearing the line twice instead of never — the same rule
 * `RoomNoticeRow` follows.
 *
 * **Nothing to press.** No toolbar, no reaction rail, and no navigation: a
 * milestone states something that happened, and there is nobody to answer. The
 * identity card summarises who it is about and its footer stays the inert
 * **soon** line, the same posture the presence strip's faces hold — opening a
 * profile is the mention pill's job and the roster's, and a row with one
 * control on it would stop reading as a statement.
 *
 * It is still an article of the feed, so Page Down lands on it like every
 * other line.
 */
export function RoomMomentRow({
  entry,
  moment,
  author,
  authors,
  feedPosition,
  rowId,
}: RoomMomentRowProps) {
  const subjectId = entry.body.subjectAuthorId ?? entry.authorId;
  // The writer's own resolved author when the moment is about them, and a fresh
  // resolve off the roster when it is about somebody else. One rule, so a
  // subject the roster has forgotten degrades exactly as a departed member's
  // old post does rather than disappearing.
  const subject = subjectId === entry.authorId ? author : toMessageAuthor(subjectId, authors);
  const subjectRef = authors.get(subjectId);
  // How that agent runs, when the room's provider could find out — the same
  // context every mention pill in this room reads.
  const agent = useAgentInfo(subjectRef?.agentRef);
  const time = formatTime(entry.createdAt);

  return (
    <div
      id={rowId}
      data-testid="room-moment"
      data-moment={moment.kind}
      role="article"
      aria-label={`Moment: ${entry.body.text}`}
      {...feedArticleProps(feedPosition)}
      className="focus-visible:ring-ring/50 px-[var(--msg-padding-x)] py-1 outline-none focus-visible:ring-2"
    >
      <div className="border-border/60 bg-muted/40 flex items-center gap-2.5 rounded-lg border px-3 py-2">
        <IdentityHoverCard
          identity={{
            kind: subject.kind,
            displayName: subject.displayName,
            handle: subjectRef?.handle ?? undefined,
            color: subject.color,
            emoji: subject.emoji,
            imageUrl: subject.imageUrl,
            origin: subjectRef?.origin,
            // A chip per fact the roster actually resolved, and nothing at all
            // for one it did not — never an invented runtime.
            agent: agent && { runtime: agent.runtime, ...(agent.model && { model: agent.model }) },
          }}
        >
          {/* Named for the identity it draws, because this is the only place
              the moment says whose milestone it is other than in its own
              sentence — and a bare decorative disc would leave a reader
              tabbing past an unlabelled thing. */}
          <span data-testid="room-moment-identity" className="flex shrink-0 items-center">
            <MessageAuthorAvatar author={subject} />
            <span className="sr-only">{subject.displayName}</span>
          </span>
        </IdentityHoverCard>
        {/* Decoration: the sentence beside it already says what happened, and
            naming the mark would make a screen reader read "sparkles" first. */}
        <MomentMark
          data-testid="room-moment-mark"
          aria-hidden
          className="text-muted-foreground size-3.5 shrink-0"
        />
        <p className="min-w-0 flex-1 text-sm">{entry.body.text}</p>
        {time.length > 0 && (
          <time
            dateTime={entry.createdAt}
            title={formatAbsoluteTime(entry.createdAt)}
            className="text-msg-timestamp shrink-0 text-xs"
          >
            {time}
          </time>
        )}
      </div>
    </div>
  );
}
