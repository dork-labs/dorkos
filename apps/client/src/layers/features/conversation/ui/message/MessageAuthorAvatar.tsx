/**
 * The avatar that opens an author group in the message list's identity gutter.
 *
 * @module features/conversation/ui/message/MessageAuthorAvatar
 */
import type { KeyboardEvent } from 'react';
import { getRuntimeDescriptor } from '@/layers/entities/runtime';
import { cn, hashToHslColor, initialOf, type IdentityOrigin } from '@/layers/shared/lib';
import { IdentityAvatar } from '@/layers/shared/ui';
import type { MessageAuthor } from '@/layers/shared/model';

/** Edge length of the runtime brand mark inside the avatar circle, in pixels. */
const BRAND_MARK_SIZE = 14;

export interface MessageAuthorAvatarProps {
  /** The message's resolved author. */
  author: MessageAuthor;
  /**
   * Open this author's profile.
   *
   * A **prop, never an import**, the same rule `IdentityHoverCard` carries: a
   * `MessageAuthor` is a view model with no roster id on it — its `id` is a
   * grouping key, and for an agent in a room it is the author ULID, which the
   * team roster does not hold. Only a caller that can join the room's roster to
   * the fleet knows which profile this face belongs to, so only a caller may
   * supply the destination.
   *
   * Omitted — a system line, an agent the fleet could not name, the session
   * transcript, the onboarding narration — the face stays exactly what it was:
   * plain art, hidden from assistive technology. Never a control that opens
   * nothing.
   */
  onViewProfile?: () => void;
  /**
   * True when this author is the person reading — which changes what the
   * control is CALLED, not what it does.
   *
   * The local human's display name is the literal string `"You"`
   * (`resolve-message-author.ts`), so the ordinary template produces
   * "Open You’s profile". Second person needs the possessive, not the
   * apostrophe: "Open your profile".
   */
  isSelf?: boolean;
  className?: string;
}

/**
 * An author's visual mark, sized to the identity gutter.
 *
 * Four faces, in order: the identity's photo when it has one, its emoji next,
 * the runtime's brand mark when the identity fell back to a runtime (spec
 * `multi-participant-message-list`, D3), and otherwise a letter avatar. The
 * first two are ordered by `IdentityAvatar` itself; this file only decides
 * what the letter slot holds. Every
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
 * **A runtime-brand color falls back to tint on its own, with nothing to
 * decide here.** A runtime's accent is a theme token (`var(--color-orange-500)`),
 * which `IdentityAvatar` itself declines to fill — the primitive checks
 * whether it can compute a readable foreground for whatever color it is
 * given and steps back to `tint` when it cannot (DOR-998), rather than this
 * call site re-deciding the same guard by hand. This is the session-chat
 * runtime-fallback case (a session with no agent, `resolveMessageAuthor`'s
 * `runtime` branch) — the room feed never sets `runtime`, so its agents
 * always resolve to a concrete color and keep the fill.
 *
 * **Decorative until it is given somewhere to go.** The display name always
 * sits beside it, so on its own the mark is hidden from assistive technology.
 * Handed an {@link MessageAuthorAvatarProps.onViewProfile} it becomes the door
 * to that author's profile — the same one a mention pill and a Team card open
 * (spec `profile-unification` §3, bug 7) — and stops being decoration: it takes
 * focus, answers Enter and Space as a button promises, and names the ACTION
 * rather than repeating the name a reader can already see beside it.
 *
 * A `role="button"` on the disc itself rather than a `<button>` wrapped around
 * it, matching `MentionPill`: the disc is a sized grid cell in the identity
 * gutter, and a wrapper would need its own copy of that sizing and its own
 * radius to ring correctly around an agent's square. The disc already has both.
 */
export function MessageAuthorAvatar({
  author,
  onViewProfile,
  isSelf = false,
  className,
}: MessageAuthorAvatarProps) {
  const brand = author.emoji || !author.runtime ? null : getRuntimeDescriptor(author.runtime);
  const BrandMark = brand?.icon;
  const color = brand?.accent ?? author.color ?? hashToHslColor(author.id);
  // No platform name to give it — see the doc above — so an origin object
  // with none still derives the Send badge without inventing a platform.
  const origin: IdentityOrigin | undefined = author.isExternal ? { platform: '' } : undefined;
  // Everything the control needs, present or absent together — a disc that is
  // reachable but unnamed, or named but unreachable, is worse than plain art.
  // `Space` as well as `Enter`, because a role of button promises both.
  const control = onViewProfile
    ? {
        role: 'button',
        // **Out of the tab order on purpose, and this is the whole design.** A
        // room is a feed that costs ONE Tab per message by contract
        // (`room-entry-actions.spec.ts`), which is why the message's own action
        // capsule is `tabIndex={-1}` and walked with arrow keys. A focusable
        // disc per author group broke that budget — three messages went from two
        // presses to cross to five — so the keyboard reaches this destination
        // through the capsule's "View profile" instead, at no Tab cost at all.
        //
        // Still a named `role="button"`: a screen reader's virtual cursor walks
        // the document rather than the tab order, so this stays reachable and
        // activatable there, and `-1` keeps it focusable programmatically.
        tabIndex: -1,
        'aria-label': isSelf ? 'Open your profile' : `Open ${author.displayName}’s profile`,
        onClick: onViewProfile,
        onKeyDown: (event: KeyboardEvent<HTMLSpanElement>) => {
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          onViewProfile();
        },
      }
    : { 'aria-hidden': true };

  return (
    <IdentityAvatar
      data-slot="message-author-avatar"
      {...control}
      color={color}
      emoji={author.emoji}
      imageUrl={author.imageUrl}
      fallback={BrandMark ? <BrandMark size={BRAND_MARK_SIZE} /> : initialOf(author.displayName)}
      kind={author.kind}
      origin={origin}
      className={cn(
        'size-[var(--msg-gutter-width)]',
        // `focus-ring` is the house recipe and it is a box-shadow, so it traces
        // the disc's own radius — an agent's square and a person's circle —
        // without either being restated here.
        onViewProfile && 'focus-ring cursor-pointer transition-opacity hover:opacity-80',
        className
      )}
    />
  );
}
