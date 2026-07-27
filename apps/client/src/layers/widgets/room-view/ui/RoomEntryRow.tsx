import type { MessageGrouping, MessageAuthor } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { MarkdownContent } from '@/layers/shared/ui';
import type { RoomEntry } from '@/layers/entities/room';
import { MessageAuthorAvatar, messageItem } from '@/layers/features/chat';

interface RoomEntryRowProps {
  /** The durable log entry to render. */
  entry: RoomEntry;
  /** Who wrote it, resolved from the room's roster. */
  author: MessageAuthor;
  /** Where this entry sits in its author group. */
  grouping: MessageGrouping;
}

/**
 * Short time display (HH:MM) for an entry's timestamp, or `''` when it is not a
 * time at all. `toLocaleTimeString` does not throw on an unparseable date — it
 * renders "Invalid Date" — so the guard has to be the parse, not a `try`.
 */
function formatTime(timestamp: string): string {
  const ms = Date.parse(timestamp);
  if (Number.isNaN(ms)) return '';
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * One line of a room's history.
 *
 * A `post` renders on the same grid session chat uses — identity gutter, then
 * the content column — so a room reads as the same surface with more people in
 * it. A `notice` is the room speaking about itself, so it renders as a quiet
 * full-width line with no author beside it: attributing "Ana stopped replying
 * here" to a person would be a lie about who said it.
 */
export function RoomEntryRow({ entry, author, grouping }: RoomEntryRowProps) {
  const time = formatTime(entry.createdAt);

  if (entry.kind === 'notice') {
    return (
      <p
        data-testid="room-notice"
        className="text-muted-foreground px-[var(--msg-padding-x)] py-2 text-xs italic"
      >
        {entry.body.text}
      </p>
    );
  }

  // A group start renders the avatar, the name and the time; a continuation
  // hangs beneath it. Derived from `grouping.position` for the same reason
  // MessageItem derives it — two sources for one fact can only drift.
  const showAuthorHeader = grouping.position === 'first' || grouping.position === 'only';
  const styles = messageItem({ position: grouping.position });

  return (
    <div data-testid="room-entry" className={styles.root()}>
      <div className={styles.gutter()}>
        {showAuthorHeader && <MessageAuthorAvatar author={author} />}
        {!showAuthorHeader && time.length > 0 && (
          <span
            className={cn(
              styles.avatarTimestamp(),
              'group-hover:text-msg-timestamp text-transparent'
            )}
          >
            {time}
          </span>
        )}
      </div>
      <div className={styles.body()}>
        {showAuthorHeader && (
          <div className={styles.header()}>
            <span className={styles.authorName()}>{author.displayName}</span>
            {time.length > 0 && (
              <span className={cn(styles.timestamp(), 'text-msg-timestamp')}>{time}</span>
            )}
          </div>
        )}
        <div data-slot="message-content" className={styles.content()}>
          <MarkdownContent content={entry.body.text} linkSafety />
        </div>
      </div>
    </div>
  );
}
