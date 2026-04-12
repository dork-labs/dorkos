import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
import type { AgentHealthStatus } from '@dorkos/shared/mesh-schemas';
import { AgentAvatar } from './AgentAvatar';

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const identityVariants = cva('inline-flex items-center min-w-0', {
  variants: {
    size: {
      xs: 'gap-1.5',
      sm: 'gap-2',
      md: 'gap-2.5',
      lg: 'gap-3',
    },
  },
  defaultVariants: {
    size: 'sm',
  },
});

const nameVariants = cva('truncate', {
  variants: {
    size: {
      xs: 'text-xs font-medium',
      sm: 'text-sm font-medium',
      md: 'text-sm font-semibold',
      lg: 'text-base font-semibold',
    },
  },
  defaultVariants: { size: 'sm' },
});

const detailVariants = cva('text-muted-foreground truncate', {
  variants: {
    size: {
      xs: 'text-[10px]',
      sm: 'text-xs',
      md: 'text-xs',
      lg: 'text-sm',
    },
  },
  defaultVariants: { size: 'sm' },
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

type IdentitySize = 'xs' | 'sm' | 'md' | 'lg';

export interface AgentIdentityProps extends VariantProps<typeof identityVariants> {
  /** CSS color string (HSL or hex override). */
  color: string;
  /** Single emoji character. */
  emoji: string;
  /** Agent display name. */
  name: string;
  /** Optional secondary content — badges, path, timestamp, etc. */
  detail?: React.ReactNode;
  /** Optional health status (forwarded to AgentAvatar). */
  healthStatus?: AgentHealthStatus;
  className?: string;
  /**
   * When provided, wraps the identity in a button element.
   * Enables interactive entry points (e.g. opening the Agent Hub).
   */
  onClick?: (e: React.MouseEvent) => void;
}

/**
 * Standard agent display — avatar + name + optional detail.
 * The entity-layer composition for agent identity, analogous to a user card.
 *
 * At `xs` and `sm` sizes the layout is single-line (name + detail inline).
 * At `md` and `lg` sizes the name and detail stack vertically.
 */
export function AgentIdentity({
  color,
  emoji,
  name,
  detail,
  size,
  healthStatus,
  className,
  onClick,
}: AgentIdentityProps) {
  const resolvedSize: IdentitySize = size ?? 'sm';
  const isStacked = resolvedSize === 'md' || resolvedSize === 'lg';

  const content = (
    <>
      <AgentAvatar color={color} emoji={emoji} size={size} healthStatus={healthStatus} />

      {isStacked ? (
        <span className="flex min-w-0 flex-col">
          <span className={nameVariants({ size })}>{name}</span>
          {detail && <span className={detailVariants({ size })}>{detail}</span>}
        </span>
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <span className={nameVariants({ size })}>{name}</span>
          {detail && <span className={detailVariants({ size })}>{detail}</span>}
        </span>
      )}
    </>
  );

  if (onClick) {
    return (
      <button
        type="button"
        data-slot="agent-identity"
        onClick={onClick}
        className={cn(
          identityVariants({ size }),
          'cursor-pointer transition-opacity hover:opacity-80',
          className
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <span data-slot="agent-identity" className={cn(identityVariants({ size }), className)}>
      {content}
    </span>
  );
}

export { identityVariants as agentIdentityVariants };
