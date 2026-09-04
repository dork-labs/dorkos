import { tv, type VariantProps } from 'tailwind-variants';
import { cn } from '@/layers/shared/lib';
import {
  identityMarkRing,
  IDENTITY_MARK_GROUP,
  PRESS_MARK,
  PRESS_ROW,
  type IdentityStatus,
} from '@/layers/shared/ui';
import { AgentAvatar } from './AgentAvatar';

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

/**
 * The identity lockup's four parts, sized by one axis.
 *
 * `tv` with slots rather than three `cva` calls: the gap, the name's type, the
 * detail's type and whether the two stack are four consequences of ONE `size`,
 * and they used to be written in four places — three variant tables that each
 * re-declared the same axis, plus a ternary the type system could not see. An
 * `xl` meant editing four things and remembering the fourth (ADR-0097).
 *
 * Slots: root, label, name, detail. Stacking lives with the sizes that stack.
 */
export const agentIdentityVariants = tv({
  slots: {
    root: 'inline-flex min-w-0 items-center',
    label: 'flex min-w-0',
    name: 'truncate',
    detail: 'text-muted-foreground truncate',
  },
  variants: {
    size: {
      xs: {
        root: 'gap-1.5',
        label: 'items-center gap-1.5',
        // 13px, not 12: `xs` is the sidebar's size, and every other row in that
        // panel writes its name at 13px. One point of difference on one row type
        // is not a distinction anybody reads — it is just a list that looks
        // slightly wrong (`specs/sidebar-simplification` D1).
        name: 'text-[13px] font-medium',
        detail: 'text-3xs',
      },
      sm: {
        root: 'gap-2',
        label: 'items-center gap-1.5',
        name: 'text-sm font-medium',
        detail: 'text-xs',
      },
      md: {
        root: 'gap-2.5',
        label: 'flex-col',
        name: 'text-sm font-semibold',
        detail: 'text-xs',
      },
      lg: {
        root: 'gap-3',
        label: 'flex-col',
        name: 'text-base font-semibold',
        detail: 'text-sm',
      },
    },
  },
  defaultVariants: {
    size: 'sm',
  },
});

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

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

interface AgentIdentityBaseProps extends VariantProps<typeof agentIdentityVariants> {
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
  const slots = agentIdentityVariants({ size });

  const label = (
    <span className={slots.label()}>
      <span className={slots.name()}>{name}</span>
      {detail && <span className={slots.detail()}>{detail}</span>}
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
            'focus-ring shrink-0 cursor-pointer rounded-md',
            PRESS_MARK
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
          slots.root(),
          // Chip tier. It used to dim to 80% on hover, which is the universal
          // idiom for DISABLED — the one thing a live control must not say. The
          // identity's own colour answers instead, on the disc, through the
          // named group.
          //
          // `focus-ring` is new here, not moved: this branch had no keyboard
          // response of any kind, so a keyboard user learned strictly less than
          // a mouse user. `rounded-md` gives that ring a shape to follow.
          IDENTITY_MARK_GROUP,
          'focus-ring cursor-pointer rounded-md',
          PRESS_ROW,
          className
        )}
      >
        {content}
      </button>
    );
  }

  return (
    <span data-slot="agent-identity" className={slots.root({ className })}>
      {content}
    </span>
  );
}
