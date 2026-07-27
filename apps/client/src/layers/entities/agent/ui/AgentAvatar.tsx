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

export interface AgentAvatarProps extends VariantProps<typeof identityAvatarVariants> {
  /** CSS color string (HSL or hex override). Used as the avatar background. */
  color: string;
  /** Single emoji character rendered inside the circle. */
  emoji: string;
  /** Optional health status — adds a colored ring and tasks for active agents. */
  healthStatus?: AgentHealthStatus;
  className?: string;
}

/**
 * Visual mark for an agent — colored circle with centered emoji.
 * The entity-layer primitive for agent identity display.
 *
 * The circle itself is {@link IdentityAvatar}, the one disc every identity in
 * the cockpit is drawn as. What an agent adds on top is the only thing here
 * that is about agents: a ring for its health, and a pulse while it is working.
 */
export function AgentAvatar({ color, emoji, size, healthStatus, className }: AgentAvatarProps) {
  return (
    <IdentityAvatar
      data-slot="agent-avatar"
      aria-hidden
      color={color}
      emoji={emoji}
      size={size}
      className={cn(healthStatus && 'ring-2', healthStatus && HEALTH_RING[healthStatus], className)}
    >
      {healthStatus === 'active' && (
        <span className="absolute -top-px -right-px size-2 rounded-full bg-emerald-500" aria-hidden>
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-40 motion-reduce:hidden" />
        </span>
      )}
    </IdentityAvatar>
  );
}
