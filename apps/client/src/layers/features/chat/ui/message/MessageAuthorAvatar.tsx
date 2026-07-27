/**
 * The avatar that opens an author group in the message list's identity gutter.
 *
 * @module features/chat/ui/message/MessageAuthorAvatar
 */
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn, hashToHslColor, initialOf } from '@/layers/shared/lib';
import { IdentityAvatar } from '@/layers/shared/ui';
import type { MessageAuthor } from '@/layers/shared/model';

/** Edge length of the runtime brand mark inside the avatar circle, in pixels. */
const BRAND_MARK_SIZE = 14;

export interface MessageAuthorAvatarProps {
  /** The message's resolved author. */
  author: MessageAuthor;
  className?: string;
}

/**
 * An author's visual mark, sized to the identity gutter.
 *
 * Three faces, in order: the agent's emoji when it has one, the runtime's brand
 * mark when the identity fell back to a runtime (spec
 * `multi-participant-message-list`, D3), and otherwise a letter avatar. Every
 * color is either the author's own or hashed from their id, so a participant
 * always reads as the same color and never changes between renders.
 *
 * Decorative — the display name always sits beside it, so the mark itself is
 * hidden from assistive technology.
 */
export function MessageAuthorAvatar({ author, className }: MessageAuthorAvatarProps) {
  const brand = author.emoji || !author.runtime ? null : getRuntimeDescriptor(author.runtime);
  const BrandMark = brand?.icon;
  const color = brand?.accent ?? author.color ?? hashToHslColor(author.id);

  return (
    <IdentityAvatar
      data-slot="message-author-avatar"
      aria-hidden
      color={color}
      emoji={author.emoji}
      fallback={BrandMark ? <BrandMark size={BRAND_MARK_SIZE} /> : initialOf(author.displayName)}
      className={cn('size-[var(--msg-gutter-width)]', className)}
    />
  );
}
