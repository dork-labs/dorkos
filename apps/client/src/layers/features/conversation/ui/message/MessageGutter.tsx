/**
 * `Message.Gutter` — the identity column beside a message: an avatar, or the
 * time it was said.
 *
 * A group start renders the avatar. A continuation renders nothing until it is
 * hovered or focused, and then the clock reading appears in the same column —
 * the one fact the grouping takes away, given back on demand.
 *
 * **The avatar is the door to who said it.** Given a destination it opens that
 * author's profile — the same address a mention pill opens — so a conversation
 * answers "who is this?" from the face as well as from the name. Given none it
 * stays plain art, hidden from assistive technology, and never a control that
 * opens nothing.
 *
 * @module features/conversation/ui/message/MessageGutter
 */
import { cn } from '@/layers/shared/lib';
import { useAppStore, type MessageAuthor as MessageAuthorIdentity } from '@/layers/shared/model';
import { formatAbsoluteTime, formatTime } from '../../lib/format-entry-time';
import { MessageAuthorAvatar } from './MessageAuthorAvatar';
import { opensAuthorGroup, useMessageStyles } from './message-styles-context';

/** What the identity column draws. */
export interface MessageGutterProps {
  /** Who wrote the message, resolved by the host. */
  author: MessageAuthorIdentity;
  /**
   * When it was said, ISO 8601. Omitted for a row that shows no time at all —
   * scripted narration, where a clock reading would make a line of a story read
   * as something somebody typed.
   */
  at?: string;
  /**
   * Open this author's profile, or `undefined` for one the host cannot address.
   * Resolved by the host, which is the only part that can join a conversation's
   * roster to the fleet — see {@link MessageAuthorAvatar}.
   */
  onViewProfile?: () => void;
  /** True when this message's author is the person reading. */
  isSelf?: boolean;
  className?: string;
}

/** The avatar rail or corner disc, and the continuation's hover timestamp. */
export function MessageGutter({
  author,
  at,
  onViewProfile,
  isSelf,
  className,
}: MessageGutterProps) {
  const { slots, position } = useMessageStyles();
  // The per-message stamps in the continuation gutter are the noisy ones the
  // preference exists to quiet, so it governs THEM and not the identity line's
  // own time. One rule for every conversation: this used to be honoured in a
  // session and ignored in a room, which made a single switch in Settings mean
  // two different things depending on which tab you had open.
  const { showTimestamps } = useAppStore();
  const time = at === undefined ? '' : formatTime(at);

  return (
    <div data-slot="message-gutter" className={cn(slots.gutter(), className)}>
      {opensAuthorGroup(position) ? (
        <MessageAuthorAvatar author={author} onViewProfile={onViewProfile} isSelf={isSelf} />
      ) : (
        time.length > 0 && (
          // A `<time>` with its own date on it, and the whole date as the title
          // a pointer reveals — a conversation scrolled back a week otherwise
          // shows nothing but clock readings that nothing anywhere can date.
          //
          // Revealed by FOCUS as well as by hover. It was hover-only in one of
          // the two rows this replaces, so a keyboard reader crossing a run of
          // messages from one person had no way to see when any of them was
          // said.
          <time
            dateTime={at}
            title={formatAbsoluteTime(at ?? '')}
            className={cn(
              slots.avatarTimestamp(),
              showTimestamps
                ? 'text-msg-timestamp'
                : 'group-focus-within:text-msg-timestamp group-hover:text-msg-timestamp text-transparent'
            )}
          >
            {time}
          </time>
        )
      )}
    </div>
  );
}
