/**
 * `Message.Body` and `Message.Content` — the column beside the identity gutter,
 * and the words inside it.
 *
 * Two elements rather than one, because they answer different questions. The
 * BODY is everything hanging off a message: the identity line, the words, the
 * files, the pills, the action capsule. The CONTENT is the words alone — the
 * one part of the row a description can honestly point at, and the box the
 * capsule is measured against (`room-entry-actions.spec.ts` reads
 * `[data-slot="message-content"]`'s parent to find where the message's own top
 * edge is). Collapsing them would leave the capsule with nothing to straddle.
 *
 * @module features/conversation/ui/message/MessageBody
 */
import type { ReactNode } from 'react';
import { cn } from '@/layers/shared/lib';
import { useMessageStyles } from './message-styles-context';

/** What the content column holds. */
export interface MessageBodyProps {
  /** The row's parts — its identity line, words, files, pills and actions. */
  children: ReactNode;
  className?: string;
}

/** The column beside the identity gutter. */
export function MessageBody({ children, className }: MessageBodyProps) {
  const { slots } = useMessageStyles();

  return (
    <div data-slot="message-body" className={cn(slots.body(), className)}>
      {children}
    </div>
  );
}

/** What a message actually says. */
export interface MessageContentProps {
  /**
   * The DOM id the row points `aria-describedby` at, when the words are their
   * own honest description.
   */
  id?: string;
  /** The host's rendered body — session parts, or a room's markdown. */
  children: ReactNode;
  className?: string;
}

/**
 * The words themselves, rendered by whichever body renderer the host supplied.
 *
 * The chrome around them is shared; what goes inside is not. A session's tool
 * cards and a room's mention pills are two renderers behind one prop, which is
 * what lets the row unify without the two message types being forced into one.
 */
export function MessageContent({ id, children, className }: MessageContentProps) {
  const { slots } = useMessageStyles();

  return (
    <div id={id} data-slot="message-content" className={cn(slots.content(), className)}>
      {children}
    </div>
  );
}
