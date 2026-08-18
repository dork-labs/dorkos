/**
 * Who wrote a room entry, and when — the two places a message row says it.
 *
 * A group START says it twice over: the avatar in the identity gutter and the
 * name-and-time line above the words. A CONTINUATION says it in neither, by
 * design — a run of messages from one person reads as one block — and gets the
 * clock reading back in the gutter on hover or focus. Both halves live here
 * because they answer one question between them, and because a change to how a
 * row is grouped has to move them together or the row starts telling two
 * different stories about who is speaking.
 *
 * Layout stays with the row: each part is handed the class it draws with
 * (`messageItem`'s slots), the same way `EntryActionBar` is handed the
 * toolbar's. See `RoomEntryRow`, which derives them once.
 *
 * @module widgets/room-view/ui/RoomEntryHeader
 */
import { cn } from '@/layers/shared/lib';
import type { MessageAuthor } from '@/layers/shared/model';
import { OriginMark } from '@/layers/entities/room';
import { MessageAuthorAvatar } from '@/layers/features/conversation';
import type { RosterAuthor } from '../lib/room-timeline';

interface RoomEntryGutterProps {
  /** Who wrote the entry, resolved from the room's roster. */
  author: MessageAuthor;
  /**
   * True on a group start, which draws the avatar; false on a continuation,
   * which draws the timestamp the author line would otherwise have carried.
   */
  showAuthorHeader: boolean;
  /** The entry's own timestamp, as the machine-readable date on a `<time>`. */
  createdAt: string;
  /** The clock reading, already formatted — empty when there is none to show. */
  time: string;
  /** The whole date, revealed by a pointer resting on the time. */
  absoluteTime: string;
  /**
   * Open this author's profile, or `undefined` for one the roster cannot
   * address — the room's own voice, or an agent the fleet could not name.
   * Resolved by the row, which is the part that can reach both the roster and
   * the fleet; the disc itself only draws what it is handed.
   */
  onViewProfile?: () => void;
  /** True when this entry's author is the person reading — see the avatar's own doc. */
  isSelf?: boolean;
  /** The identity column's own layout (`messageItem`'s `gutter` slot). */
  className: string;
  /** The continuation timestamp's own layout (`messageItem`'s `avatarTimestamp` slot). */
  timestampClassName: string;
}

interface RoomEntryAuthorLineProps {
  /**
   * The DOM id the row points `aria-labelledby` at — this line IS the row's
   * accessible name, rather than a sentence written for the purpose.
   */
  id: string;
  /** Who wrote the entry, resolved from the room's roster. */
  author: MessageAuthor;
  /**
   * The same author as the ROSTER holds them, or undefined once they have
   * left. Read here only for `origin`, which is what draws the origin mark
   * beside an external author's name (chats-as-channels spec §4.3, §9).
   */
  authorRef: RosterAuthor | undefined;
  /** The entry's own timestamp, as the machine-readable date on a `<time>`. */
  createdAt: string;
  /** The clock reading, already formatted — empty when there is none to show. */
  time: string;
  /** The whole date, revealed by a pointer resting on the time. */
  absoluteTime: string;
  /** The line's own layout (`messageItem`'s `header` slot). */
  className: string;
  /** The name's own type (`messageItem`'s `authorName` slot). */
  nameClassName: string;
  /** The timestamp's own type (`messageItem`'s `timestamp` slot). */
  timestampClassName: string;
}

/**
 * The identity column beside a message: an avatar, or the time it was said.
 *
 * A group start renders the avatar. A continuation renders nothing until it is
 * hovered or focused, and then the clock reading appears in the same column —
 * the one fact the grouping takes away, given back on demand.
 *
 * **The avatar is the door to who said it.** Given a destination it opens that
 * author's profile — the same address the mention pill in the body opens, so a
 * room answers "who is this?" from the face as well as from the name.
 */
export function RoomEntryGutter({
  author,
  showAuthorHeader,
  createdAt,
  time,
  absoluteTime,
  onViewProfile,
  isSelf,
  className,
  timestampClassName,
}: RoomEntryGutterProps) {
  return (
    <div className={className}>
      {showAuthorHeader && (
        <MessageAuthorAvatar author={author} onViewProfile={onViewProfile} isSelf={isSelf} />
      )}
      {!showAuthorHeader && time.length > 0 && (
        <time
          dateTime={createdAt}
          title={absoluteTime}
          className={cn(
            timestampClassName,
            // Revealed by FOCUS as well as by hover. It was hover-only, so
            // a keyboard reader crossing a run of messages from one person
            // had no way to see when any of them was said — the one fact
            // the grouping takes away is the one the reveal was meant to
            // give back, and half the readers of this room could not ask
            // for it.
            'group-focus-within:text-msg-timestamp group-hover:text-msg-timestamp text-transparent'
          )}
        >
          {time}
        </time>
      )}
    </div>
  );
}

/**
 * The line above a group's first message: who is speaking, where they are
 * speaking from, and when.
 *
 * It is also the row's accessible NAME, pointed at by `aria-labelledby` rather
 * than restated — see `RoomEntryRow`, which explains why a row names itself
 * from the words already on screen.
 */
export function RoomEntryAuthorLine({
  id,
  author,
  authorRef,
  createdAt,
  time,
  absoluteTime,
  className,
  nameClassName,
  timestampClassName,
}: RoomEntryAuthorLineProps) {
  return (
    <div id={id} className={className}>
      <span className={nameClassName}>{author.displayName}</span>
      {/* Legible at a glance beside the message it is about (spec §9)
          — never a tooltip a reader would have to go looking for. */}
      {authorRef && <OriginMark origin={authorRef.origin} />}
      {time.length > 0 && (
        // A `<time>` with its own date on it, and the whole date as the
        // title a pointer reveals. A room scrolled back a week showed
        // nothing but clock times, so "which day was this?" had no
        // answer anywhere on the surface — not on hover, not in the
        // markup, and not to a screen reader.
        <time
          dateTime={createdAt}
          title={absoluteTime}
          className={cn(timestampClassName, 'text-msg-timestamp')}
        >
          {time}
        </time>
      )}
    </div>
  );
}
