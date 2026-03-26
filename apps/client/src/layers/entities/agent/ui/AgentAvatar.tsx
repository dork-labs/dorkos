import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
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
// Variants
// ---------------------------------------------------------------------------

const avatarVariants = cva(
  'relative inline-flex shrink-0 items-center justify-center rounded-full',
  {
    variants: {
      size: {
        xs: 'size-5 text-xs',
        sm: 'size-7 text-sm',
        md: 'size-9 text-lg',
        lg: 'size-12 text-2xl',
      },
    },
    defaultVariants: {
      size: 'sm',
    },
  }
);

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AgentAvatarProps extends VariantProps<typeof avatarVariants> {
  /** CSS color string (HSL or hex override). Used as the avatar background. */
  color: string;
  /** Single emoji character rendered inside the circle. */
  emoji: string;
  /** Optional health status — adds a colored ring and pulse for active agents. */
  healthStatus?: AgentHealthStatus;
  className?: string;
}

/**
 * Visual mark for an agent — colored circle with centered emoji.
 * The entity-layer primitive for agent identity display.
 */
export function AgentAvatar({ color, emoji, size, healthStatus, className }: AgentAvatarProps) {
  return (
    <span
      data-slot="agent-avatar"
      className={cn(
        avatarVariants({ size }),
        healthStatus && 'ring-2',
        healthStatus && HEALTH_RING[healthStatus],
        className
      )}
      style={{ backgroundColor: `color-mix(in oklch, ${color} 18%, transparent)` }}
      aria-hidden
    >
      <span className="leading-none">{emoji}</span>
      {healthStatus === 'active' && (
        <span className="absolute -top-px -right-px size-2 rounded-full bg-emerald-500" aria-hidden>
          <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500 opacity-40 motion-reduce:hidden" />
        </span>
      )}
    </span>
  );
}

export { avatarVariants as agentAvatarVariants };
