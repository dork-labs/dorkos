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
  /** A photo for this agent, when it has one — forwarded to {@link AgentAvatar}. */
  imageUrl?: string;
  /** Agent display name. */
  name: string;
  /** Optional secondary content — badges, path, timestamp, etc. */
  detail?: React.ReactNode;
  /** Optional health status (forwarded to AgentAvatar). */
  healthStatus?: AgentHealthStatus;
  /**
   * Show the avatar alone. The name stays in the accessibility tree rather than
   * moving to an `aria-label`, so the identity still announces (and still names an
   * `onClick` button) when there is no room to draw it.
   */
  nameHidden?: boolean;
  className?: string;
  /**
   * When provided, wraps the identity in a button element.
   * Enables interactive entry points (e.g. opening the Agent Hub).
   */
  onClick?: (e: React.MouseEvent) => void;
  /**
   * Make the FACE alone a control, leaving the name as plain text.
   *
   * For the surfaces where the row AROUND this lockup already owns the click —
   * a sidebar agent row selects the agent — so the whole-lockup
   * {@link AgentIdentityProps.onClick} would eat the row's own target. The
   * caller stops the event itself if the row must not also fire.
   *
   * Ignored when `onClick` is set: that path is already a `<button>`, and a
   * button inside a button is invalid HTML that browsers silently unnest.
   */
  onAvatarClick?: (e: React.MouseEvent) => void;
  /** Accessible name for the avatar button — required to make one, ignored otherwise. */
  avatarLabel?: string;
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
  imageUrl,
  name,
  detail,
  size,
  healthStatus,
  nameHidden,
  className,
  onClick,
  onAvatarClick,
  avatarLabel,
}: AgentIdentityProps) {
  const resolvedSize: IdentitySize = size ?? 'sm';
  const isStacked = resolvedSize === 'md' || resolvedSize === 'lg';

  const label = (
    <span className={cn('flex min-w-0', isStacked ? 'flex-col' : 'items-center gap-1.5')}>
      <span className={nameVariants({ size })}>{name}</span>
      {detail && <span className={detailVariants({ size })}>{detail}</span>}
    </span>
  );

  const avatar = (
    <AgentAvatar
      color={color}
      emoji={emoji}
      imageUrl={imageUrl}
      size={size}
      healthStatus={healthStatus}
    />
  );

  const content = (
    <>
      {onAvatarClick && !onClick && avatarLabel ? (
        <button
          type="button"
          data-slot="agent-identity-face"
          onClick={onAvatarClick}
          aria-label={avatarLabel}
          className="focus-ring shrink-0 cursor-pointer rounded-full transition-opacity hover:opacity-80"
        >
          {avatar}
        </button>
      ) : (
        avatar
      )}
      {nameHidden ? <span className="sr-only">{name}</span> : label}
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
