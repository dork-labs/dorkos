/**
 * The avatar that opens an author group in the message list's identity gutter.
 *
 * @module features/chat/ui/message/MessageAuthorAvatar
 */
import { AgentAvatar, agentAvatarVariants } from '@/layers/entities/agent';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn, hashToHslColor } from '@/layers/shared/lib';
import type { MessageAuthor } from '@/layers/shared/model';

/** Glyph for a display name with no letter or digit to draw an initial from. */
const FALLBACK_INITIAL = '?';

/** Edge length of the runtime brand mark inside the avatar circle, in pixels. */
const BRAND_MARK_SIZE = 14;

/** How much of the author's color tints the avatar circle — matches `AgentAvatar`. */
const TINT_STRENGTH = '18%';

/** First letter or digit of a display name, uppercased. */
function initialOf(displayName: string): string {
  const match = /\p{L}|\p{N}/u.exec(displayName);
  return match ? match[0].toUpperCase() : FALLBACK_INITIAL;
}

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
  if (author.emoji) {
    return (
      <AgentAvatar
        color={author.color ?? hashToHslColor(author.id)}
        emoji={author.emoji}
        className={cn('size-[var(--msg-gutter-width)]', className)}
      />
    );
  }

  const brand = author.runtime ? getRuntimeDescriptor(author.runtime) : null;
  const BrandMark = brand?.icon;
  const color = brand?.accent ?? author.color ?? hashToHslColor(author.id);

  return (
    <span
      data-slot="message-author-avatar"
      aria-hidden
      className={cn(
        agentAvatarVariants(),
        'size-[var(--msg-gutter-width)] text-xs font-medium',
        className
      )}
      // The tint is mixed from a per-author color — a hash or a runtime accent —
      // that Tailwind cannot know at build time, the same reason AgentAvatar
      // styles its own background inline.
      style={{ backgroundColor: `color-mix(in oklch, ${color} ${TINT_STRENGTH}, transparent)` }}
    >
      {BrandMark ? <BrandMark size={BRAND_MARK_SIZE} /> : initialOf(author.displayName)}
    </span>
  );
}
