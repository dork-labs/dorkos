/**
 * A milestone in the feed — the third thing a room row can be
 * (team-room-home spec D5.1).
 *
 * A moment is a POST: the same entry shape, on the same log, carrying
 * `body.moment` to say what it marks and what it was read off. So this file
 * owns only what follows from a row being one — the calm band it draws in, the
 * identity it draws BESIDE the words, and the one mark the whole family shares.
 * The host row still decides which of the three kinds of line an entry is, and
 * resolves the identity: joining a room's roster to the fleet is the host's
 * knowledge, not this row's.
 *
 * **Warm, and quiet about it.** The only colour on the row is the identity's
 * own, carried by the disc; the band itself is the same muted surface every
 * other quiet thing in the cockpit uses. No brand orange (it means interaction,
 * and there is nothing here to press), no burst, no confetti. There is also no
 * animation at all, which is the honest way to respect reduced motion: a
 * milestone that arrives in a feed a person is reading should not move the
 * words under their eyes.
 *
 * @module features/conversation/ui/rows/MomentRow
 */
import { icons } from '@dorkos/icons/registry';
import type { RoomMoment } from '@dorkos/shared/room-schemas';
import type { IdentityOrigin } from '@/layers/shared/lib';
import { feedArticleProps, type FeedPosition } from '@/layers/shared/model';
import type { MessageAuthor } from '@/layers/shared/model';
import { IdentityHoverCard } from '@/layers/shared/ui';
import type { RoomEntry } from '@/layers/entities/room';
import { formatAbsoluteTime, formatTime } from '../../lib/format-entry-time';
import { MessageAuthorAvatar } from '../message/MessageAuthorAvatar';

/** The one mark every moment carries — see `@dorkos/icons` for why there is only one. */
const MomentMark = icons.moment;

/** What the identity card shows about a moment's subject beyond their face. */
export interface MomentSubjectIdentity {
  /** The verified handle, without its `@`, when the roster holds one. */
  handle?: string;
  /** Where they speak from, when it is not this machine. */
  origin?: IdentityOrigin;
  /** How that agent runs, when the fleet could say. Never invented. */
  agent?: { runtime: string; model?: string };
}

interface MomentRowProps {
  /** The entry, whose `body.moment` made it one. */
  entry: RoomEntry;
  /** That moment, already read off the body by the row that dispatched here. */
  moment: RoomMoment;
  /**
   * The identity the milestone is ABOUT, resolved by the host.
   *
   * A prop, never a lookup: `body.subjectAuthorId` resolves against the room's
   * roster joined to the fleet, and only the host can reach both — the same
   * rule {@link MessageAuthorAvatar} states for its own destination.
   */
  subject: MessageAuthor;
  /** The rest of what the subject's card shows, when the host resolved it. */
  subjectIdentity?: MomentSubjectIdentity;
  /**
   * Where this row sits in the feed it is rendering inside, or omitted where it
   * renders outside a feed entirely — see the host row, which owns the rule.
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
 * {@link NoticeRow} follows.
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
export function MomentRow({
  entry,
  moment,
  subject,
  subjectIdentity,
  feedPosition,
  rowId,
}: MomentRowProps) {
  const time = formatTime(entry.createdAt);

  return (
    <div
      id={rowId}
      data-slot="moment-row"
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
            handle: subjectIdentity?.handle,
            color: subject.color,
            emoji: subject.emoji,
            imageUrl: subject.imageUrl,
            origin: subjectIdentity?.origin,
            // A chip per fact the host actually resolved, and nothing at all
            // for one it did not — never an invented runtime.
            agent: subjectIdentity?.agent,
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
