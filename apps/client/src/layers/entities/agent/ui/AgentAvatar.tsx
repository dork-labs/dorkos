import type * as React from 'react';
import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
import { IdentityAvatar, identityAvatarVariants } from '@/layers/shared/ui';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Health status ring styles
// ---------------------------------------------------------------------------

/**
 * The ring an agent's mesh health draws around its disc.
 *
 * Theme tokens, not raw palette colours: the `active` ring sits ~2px from the
 * working dot, and two greens that disagree by a shade read as a rendering
 * bug rather than two facts. `stale` is deliberately the muted foreground —
 * "we have not heard from it" is an absence, not a status colour.
 */
const HEALTH_RING: Record<AgentHealthStatus, string> = {
  active: 'ring-status-success/60',
  inactive: 'ring-status-warning/60',
  stale: 'ring-muted-foreground/20',
  unreachable: 'ring-status-error/60',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AgentAvatarProps {
  /** CSS color string (HSL or hex override). Used as the avatar background. */
  color: string;
  /** Single emoji character rendered inside the square. */
  emoji: string;
  /** Diameter of the disc — the same four the whole cockpit sizes identities by. */
  size?: VariantProps<typeof identityAvatarVariants>['size'];
  /** Optional mesh health — adds a coloured ring keyed on when the agent was last seen. */
  healthStatus?: AgentHealthStatus;
  /**
   * Whether the agent is working right now.
   *
   * Defaults to `healthStatus === 'active'` — the mesh's "seen within the last
   * hour" (`ACTIVE_THRESHOLD_MINUTES`), the same condition the pre-refactor dot
   * used. That is a liveness proxy, not a statement about work; pass `working`
   * explicitly when the caller actually knows, including `false` to silence it.
   */
  working?: boolean;
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
 * Visual mark for an agent — its colour, its emoji, and the two things that
 * are only true of agents.
 *
 * The disc itself is {@link IdentityAvatar}, told `kind="agent"`, which is
 * where square/fill/Bot comes from. **This wrapper takes no `shape` or
 * `variant`**: a caller that could pass `shape="circle"` is precisely how an
 * agent ended up drawn as a person in most of the places that draw one, and
 * twelve call sites reach the convention through this file.
 *
 * What stays here is what `shared/` must not learn: a ring keyed on mesh
 * health, and the translation from "seen within the last hour" to the disc's
 * own kind-agnostic `working` slot.
 */
export function AgentAvatar({
  color,
  emoji,
  size,
  healthStatus,
  working,
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
      size={size}
      // `undefined` is not a value here — it is the absence that lets
      // `kind="agent"` supply the Bot glyph. Only `null` suppresses it.
      badge={badge}
      working={working ?? healthStatus === 'active'}
      className={cn(healthStatus && 'ring-2', healthStatus && HEALTH_RING[healthStatus], className)}
    />
  );
}
