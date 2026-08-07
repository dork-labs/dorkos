/**
 * The avatar that opens an author group in the message list's identity gutter.
 *
 * @module features/chat/ui/message/MessageAuthorAvatar
 */
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn, hashToHslColor, initialOf, type IdentityOrigin } from '@/layers/shared/lib';
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
 * **Shape, fill and badge come from `kind`** — the same derivation
 * `IdentityHoverCard` reads (spec `composer-identity-components`, direction
 * C; `identity-consistency` W1.3): an agent draws as a filled square carrying
 * a small Bot badge; everyone else stays a tinted circle, with a Send badge
 * added for someone bridged in from outside this machine. `MessageAuthor`
 * only ever knows THAT a sender is bridged, never from which platform, so the
 * `origin` this passes carries no platform name — `IdentityAvatar`'s own
 * `ADAPTER_LOGO_MAP[...] ?? <Send />` fallback is what turns that into the
 * Send badge. Most agents have no stored `color` — the emoji/runtime-brand
 * cases above are the exception — so the filled square usually lands on the
 * same hashed color every other identity falls back to; `IdentityAvatar`
 * itself is what keeps the fallback glyph legible against whatever that hash
 * turns out to be (`readableForeground`), so nothing here has to repeat that
 * work.
 *
 * **Fill is skipped for a runtime-brand color.** `readableForeground` only
 * parses hex/`rgb()`/`hsl()`, and a runtime's accent is a theme token
 * (`var(--color-orange-500)`) — unparseable, so `fill` would always compute a
 * near-white foreground regardless of how light the token actually renders.
 * `tint` has no such problem (`color-mix` resolves a `var()` token fine), so
 * an agent whose color is a token falls back to tint rather than risk a
 * washed-out brand mark. This is the session-chat runtime-fallback case (a
 * session with no agent, `resolveMessageAuthor`'s `runtime` branch) — the
 * room feed never sets `runtime`, so its agents always resolve to a concrete
 * color and keep the fill.
 *
 * Decorative — the display name always sits beside it, so the mark itself is
 * hidden from assistive technology.
 */
export function MessageAuthorAvatar({ author, className }: MessageAuthorAvatarProps) {
  const brand = author.emoji || !author.runtime ? null : getRuntimeDescriptor(author.runtime);
  const BrandMark = brand?.icon;
  const color = brand?.accent ?? author.color ?? hashToHslColor(author.id);
  // See the fill-skip note above: a `var(...)` token can't be read by
  // `readableForeground`, so it never gets the fill treatment.
  const canFill = !color.trim().startsWith('var(');
  // `kind` derives shape, fill and badge together. The one axis it can't
  // decide alone is `variant`: the runtime-brand fill-skip case above steps
  // an agent back to `tint`; every other identity leaves `kind` to choose.
  const variant = author.kind === 'agent' && !canFill ? 'tint' : undefined;
  // No platform name to give it — see the doc above — so an origin object
  // with none still derives the Send badge without inventing a platform.
  const origin: IdentityOrigin | undefined = author.isExternal ? { platform: '' } : undefined;

  return (
    <IdentityAvatar
      data-slot="message-author-avatar"
      aria-hidden
      color={color}
      emoji={author.emoji}
      fallback={BrandMark ? <BrandMark size={BRAND_MARK_SIZE} /> : initialOf(author.displayName)}
      kind={author.kind}
      origin={origin}
      variant={variant}
      className={cn('size-[var(--msg-gutter-width)]', className)}
    />
  );
}
