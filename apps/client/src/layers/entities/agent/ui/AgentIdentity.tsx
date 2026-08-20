import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/layers/shared/lib';
import { identityMarkRing, IDENTITY_MARK_GROUP, type IdentityStatus } from '@/layers/shared/ui';
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
      // 13px, not 12: `xs` is the sidebar's size, and every other row in that
      // panel writes its name at 13px. One point of difference on one row type
      // is not a distinction anybody reads — it is just a list that looks
      // slightly wrong (`specs/sidebar-simplification` D1).
      xs: 'text-[13px] font-medium',
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

/**
 * Whether the FACE alone is a control — and if it is, what it announces as.
 *
 * A union rather than two optional props, because the two are one decision. An
 * `onAvatarClick` with no `avatarLabel` is an icon-only button with no
 * accessible name: it renders, it works with a mouse, and a screen reader calls
 * it "button". Nothing would have caught that at runtime, so the compiler
 * refuses the arrangement instead.
 */
type AgentFaceControl =
  | {
      /**
       * Make the FACE alone a control, leaving the name as plain text.
       *
       * For the surfaces where the row AROUND this lockup already owns the
       * click — a sidebar agent row selects the agent — so the whole-lockup
       * {@link AgentIdentityBaseProps.onClick} would eat the row's own target.
       * The caller stops the event itself if the row must not also fire.
       *
       * Ignored when `onClick` is set: that path is already a `<button>`, and a
       * button inside a button is invalid HTML that browsers silently unnest.
       */
      onAvatarClick: (e: React.MouseEvent) => void;
      /** What the face announces as — name the ACTION, e.g. `Open Scout’s profile`. */
      avatarLabel: string;
    }
  | { onAvatarClick?: never; avatarLabel?: never };

interface AgentIdentityBaseProps extends VariantProps<typeof identityVariants> {
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
  /**
   * What this agent is doing right now — forwarded to the disc's corner dot.
   * Pass it only where the surface observes turn-level state; see
   * {@link AgentAvatar}.
   */
  status?: IdentityStatus;
  /**
   * Show the avatar alone. The name stays in the accessibility tree rather than
   * moving to an `aria-label`, so the identity still announces (and still names an
   * `onClick` button) when there is no room to draw it.
   */
  nameHidden?: boolean;
  className?: string;
  /**
   * When provided, wraps the identity in a button element.
   * Enables interactive entry points (e.g. opening the agent's profile).
   */
  onClick?: (e: React.MouseEvent) => void;
}

/** Everything the identity lockup draws, plus the optional face control. */
export type AgentIdentityProps = AgentIdentityBaseProps & AgentFaceControl;

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
  status,
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

  // Mark tier: when this lockup (or its face alone) is a control, the disc
  // answers the pointer by ringing itself in the agent's own colour. Nothing
  // competes for that ring any more — mesh health used to spend it, and the
  // lockup fell back to a neutral row hover whenever it did.
  const marksIdentity = onClick !== undefined || onAvatarClick !== undefined;

  const avatar = (
    <AgentAvatar
      color={color}
      emoji={emoji}
      imageUrl={imageUrl}
      size={size}
      status={status}
      className={cn(marksIdentity && identityMarkRing.group)}
    />
  );

  const content = (
    <>
      {onAvatarClick && !onClick ? (
        <button
          type="button"
          data-slot="agent-identity-face"
          onClick={onAvatarClick}
          aria-label={avatarLabel}
          // `rounded-md`, matching the disc it wraps: an agent's face is a
          // rounded SQUARE (spec `identity-consistency` §W1), so a circular
          // focus ring around it draws a shape the identity does not have.
          //
          // The NAMED group is what lets the disc inside answer this button's
          // hover and its keyboard focus with the same ring — and nothing
          // else's. The press scales to 0.94 — the mark-sized step, because one
          // number cannot fit a 300px card and a 24px disc.
          className={cn(
            IDENTITY_MARK_GROUP,
            'focus-ring shrink-0 cursor-pointer rounded-md transition-[scale] duration-(--identity-press) ease-(--identity-ease-out) active:scale-[0.94]'
          )}
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
          // Chip tier. It used to dim to 80% on hover, which is the universal
          // idiom for DISABLED — the one thing a live control must not say. The
          // identity's own colour answers instead, on the disc, through the
          // named group.
          //
          // `focus-ring` is new here, not moved: this branch had no keyboard
          // response of any kind, so a keyboard user learned strictly less than
          // a mouse user. `rounded-md` gives that ring a shape to follow.
          IDENTITY_MARK_GROUP,
          'focus-ring cursor-pointer rounded-md transition-[scale] duration-(--identity-press) ease-(--identity-ease-out) active:scale-[0.98]',
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
