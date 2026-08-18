/**
 * `Message.Author` — the line above a group's first message: who is speaking,
 * where they are speaking from, and when.
 *
 * It is also the row's accessible NAME, pointed at by `aria-labelledby` rather
 * than restated — which is why it takes an `id`. A row that named itself with a
 * sentence written for screen readers would be saying something the person
 * beside it cannot see, and that was the double-speak DOR-583 removed.
 *
 * It draws nothing on a continuation. A run of messages from one person reads
 * as one block, and the clock reading the grouping takes away comes back in the
 * gutter on hover — see {@link MessageGutter}.
 *
 * @module features/conversation/ui/message/MessageAuthor
 */
import { Slot } from 'radix-ui';
import { cn } from '@/layers/shared/lib';
import type { IdentityOrigin } from '@/layers/shared/lib';
import type { MessageAuthor as MessageAuthorIdentity } from '@/layers/shared/model';
import { OriginMark } from '@/layers/entities/room';
import { formatAbsoluteTime, formatTime } from '../../lib/format-entry-time';
import { opensAuthorGroup, useMessageStyles } from './message-styles-context';

/** What the identity line draws. */
export interface MessageAuthorProps {
  /** The DOM id the row points `aria-labelledby` at. */
  id?: string;
  /** Who wrote the message, resolved by the host. */
  author: MessageAuthorIdentity;
  /** When it was said, ISO 8601. Omitted for a row that shows no time. */
  at?: string;
  /**
   * Where this author speaks from, when the host resolved one and it is not
   * this machine. Legible at a glance beside the name (chats-as-channels §9) —
   * never a tooltip a reader would have to go looking for.
   */
  origin?: IdentityOrigin;
  /** Render as the child element instead of a `div`. */
  asChild?: boolean;
  className?: string;
}

/** The name, the origin mark, and the time — or nothing, on a continuation. */
export function MessageAuthor({
  id,
  author,
  at,
  origin,
  asChild = false,
  className,
}: MessageAuthorProps) {
  const { slots, position } = useMessageStyles();
  const time = at === undefined ? '' : formatTime(at);

  if (!opensAuthorGroup(position)) return null;

  const Comp = asChild ? Slot.Root : 'div';

  return (
    <Comp id={id} data-slot="message-author" className={cn(slots.header(), className)}>
      <span className={slots.authorName()}>{author.displayName}</span>
      {origin !== undefined && <OriginMark origin={origin} />}
      {time.length > 0 && (
        <time
          dateTime={at}
          title={formatAbsoluteTime(at ?? '')}
          className={cn(slots.timestamp(), 'text-msg-timestamp')}
        >
          {time}
        </time>
      )}
    </Comp>
  );
}
