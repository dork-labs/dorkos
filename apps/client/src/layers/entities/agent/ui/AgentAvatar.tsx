import type * as React from 'react';
import type { VariantProps } from 'class-variance-authority';
import { IdentityAvatar, identityAvatarVariants, type IdentityStatus } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AgentAvatarProps {
  /** CSS color string (HSL or hex override). Used as the avatar background. */
  color: string;
  /** Single emoji character rendered inside the square. */
  emoji: string;
  /**
   * A photo for this agent, when it has one — drawn in place of the emoji.
   *
   * Nothing fills it today: an agent's identity language is its emoji and its
   * colour, and the upload surface (DOR-976) is for people only. It is a
   * pass-through so an agent CAN carry one the day something sets it, without
   * this file or the disc beneath it changing.
   */
  imageUrl?: string;
  /** Diameter of the disc — the same four the whole cockpit sizes identities by. */
  size?: VariantProps<typeof identityAvatarVariants>['size'];
  /**
   * What this agent is doing right now — forwarded to the disc's own corner dot.
   *
   * **Only pass it if you actually know.** This used to default to
   * `healthStatus === 'active'`, which is the mesh's "we heard from it inside
   * the last hour" — so every list row in the cockpit wore a pulsing
   * right-now dot sourced from an hour-old heartbeat. A caller with no
   * turn-level signal passes nothing, and the disc says nothing.
   */
  status?: IdentityStatus;
  /**
   * The corner mark. Defaults to the Bot glyph every agent wears; `null` is
   * the sanctioned opt-out for a list where every row is an agent and the
   * column of identical glyphs says nothing.
   *
   * Note what is NOT here: `shape` and `variant`. The badge was never how the
   * convention got skipped — the silhouette was, and that stays sealed.
   */
  badge?: React.ReactNode;
  className?: string;
}

/**
 * Visual mark for an agent — its colour, its emoji, and the square silhouette
 * that is only true of agents.
 *
 * The disc itself is {@link IdentityAvatar}, told `kind="agent"`, which is
 * where square/fill/Bot comes from. **This wrapper takes no `shape` or
 * `variant`**: a caller that could pass `shape="circle"` is precisely how an
 * agent ended up drawn as a person in most of the places that draw one, and
 * twelve call sites reach the convention through this file.
 *
 * **It carries no mesh health, deliberately.** It used to draw a coloured 2px
 * ring keyed on when the agent was last seen, ~2px outside a working dot lit
 * from the same fact — one signal wearing two shapes, on every list row in the
 * product. Health is a diagnostic about the last hour and the corner dot is a
 * claim about this second; the two surfaces that genuinely need health (the
 * profile header, the mesh topology page) now say it in their own words, where
 * there is room to say which health it is.
 */
export function AgentAvatar({
  color,
  emoji,
  imageUrl,
  size,
  status,
  badge,
  className,
}: AgentAvatarProps) {
  return (
    <IdentityAvatar
      data-slot="agent-avatar"
      aria-hidden
      kind="agent"
      color={color}
      emoji={emoji}
      imageUrl={imageUrl}
      size={size}
      // `undefined` is not a value here — it is the absence that lets
      // `kind="agent"` supply the Bot glyph. Only `null` suppresses it.
      badge={badge}
      status={status}
      className={className}
    />
  );
}
