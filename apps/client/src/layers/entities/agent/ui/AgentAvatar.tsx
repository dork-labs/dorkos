import type { VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
import { IdentityAvatar, identityAvatarVariants } from '@/layers/shared/ui';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';

// ---------------------------------------------------------------------------
// Health status ring styles
// ---------------------------------------------------------------------------

const HEALTH_RING: Record<AgentHealthStatus, string> = {
  active: 'ring-emerald-500/60',
  inactive: 'ring-amber-500/60',
  stale: 'ring-muted-foreground/20',
  unreachable: 'ring-red-500/60',
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
  /** Optional health status — adds a colored ring, and pulses while the agent is reachable and busy. */
  healthStatus?: AgentHealthStatus;
  /**
   * Whether the agent is working right now. Defaults to what its health says
   * (`active` means reachable and busy); pass it explicitly when the caller
   * knows better, including `false` to silence the dot.
   */
  working?: boolean;
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
 * health, and the translation from "reachable and busy" to the disc's own
 * kind-agnostic `working` slot.
 */
export function AgentAvatar({
  color,
  emoji,
  size,
  healthStatus,
  working,
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
      working={working ?? healthStatus === 'active'}
      className={cn(healthStatus && 'ring-2', healthStatus && HEALTH_RING[healthStatus], className)}
    />
  );
}
