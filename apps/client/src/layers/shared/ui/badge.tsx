import * as React from 'react';
import { cva } from 'class-variance-authority';
import { Check, CircleX, TriangleAlert, type LucideIcon } from 'lucide-react';
import { Slot } from 'radix-ui';
import { cn } from '@/layers/shared/lib/utils';
import { STATUS_DOT_PULSE } from './status-dot';

/**
 * The meanings a badge can carry. `info` is accepted because agents send it
 * over the gen-ui wire, and it draws as `neutral`: blue is not a resting state
 * in this product, so a badge has no blue.
 */
export type BadgeTone = 'neutral' | 'warning' | 'error' | 'success' | 'info';

/** The two badge sizes. */
export type BadgeSize = 'sm' | 'xs';

/**
 * The glyph each tone brings with it, so colour is never the only signal.
 * `neutral` brings none: a fact has nothing to warn about.
 */
const TONE_ICON: Partial<Record<BadgeTone, LucideIcon>> = {
  warning: TriangleAlert,
  error: CircleX,
  success: Check,
};

/**
 * The status colour, spent on the glyph and never on the word. A coloured word
 * on the 7% tint fails AA on the sidebar and a selected row (amber 4.28, red
 * 4.13 dark selected); the glyph only has to clear 3:1, and does everywhere.
 */
const TONE_ICON_COLOR: Partial<Record<BadgeTone, string>> = {
  warning: 'text-status-warning-fg',
  error: 'text-status-error-fg',
  success: 'text-status-success-fg',
};

const badgeVariants = cva(
  // No border and no shadow: one 7% tint of the foreground, so a badge reads the
  // same on the page, a card, the sidebar and a selected row in both themes.
  // `rounded-full` always: the guide's radius table gives pills, avatars and
  // badges the full radius, and nothing else.
  'bg-foreground/7 inline-flex items-center rounded-full font-medium whitespace-nowrap tabular-nums [&>svg]:size-(--size-icon-xs) [&>svg]:shrink-0',
  {
    variants: {
      size: {
        // 12/16 at 20px high on desktop; the type token scales it to 15px on a
        // phone, and the height follows.
        sm: 'gap-1 px-2 py-0.5 text-xs max-md:gap-1.5',
        // 11/16 at 18px: `text-3xs` is kept for counts and initials, so the
        // small badge moved up a step from 10px.
        xs: 'text-2xs gap-1 px-1.5 py-px max-md:gap-1.5',
      },
      // A neutral badge states a fact in the quiet grey; a toned one names a
      // state, so its word is full strength beside the coloured glyph.
      emphasis: {
        quiet: 'text-muted-foreground',
        strong: 'text-foreground',
      },
    },
    defaultVariants: {
      size: 'sm',
      emphasis: 'quiet',
    },
  }
);

/**
 * The old fill axis. Every value now draws the one tint, and `destructive`
 * resolves to `tone="error"`.
 *
 * @deprecated Removed with the Badge codemod (Phase 2 PR B). Drop it.
 */
type BadgeVariant = 'default' | 'secondary' | 'destructive' | 'outline' | null;

/**
 * The old shape axis. Every badge is a pill now.
 *
 * @deprecated Removed with the Badge codemod (Phase 2 PR B). Drop it.
 */
type BadgeShape = 'default' | 'pill' | null;

/** Everything a badge draws. */
export interface BadgeProps extends React.ComponentProps<'span'> {
  /** What the badge means. Defaults to `neutral`. */
  tone?: BadgeTone | null;
  /** `sm` (12px) or `xs` (11px). Defaults to `sm`. */
  size?: BadgeSize | null;
  /**
   * Overrides the glyph the tone brings. `null` removes it, for a badge whose
   * own children already carry one.
   */
  icon?: LucideIcon | null;
  /** Running this second: the pulsing green dot, and the word at full strength. */
  live?: boolean;
  /** Render the caller's own element as the badge: a link, a `<dd>`. */
  asChild?: boolean;
  /** @deprecated See {@link BadgeVariant}. */
  variant?: BadgeVariant;
  /** @deprecated See {@link BadgeShape}. */
  shape?: BadgeShape;
}

/** The tone a badge draws, after the deprecated `variant` and `info` resolve. */
function resolveTone(tone: BadgeTone | null | undefined, variant: BadgeVariant | undefined) {
  if (tone && tone !== 'info') return tone;
  if (!tone && variant === 'destructive') return 'error';
  return 'neutral';
}

/**
 * A small inert label: a state, a category, a fact.
 *
 * A `<span>`, so it is legal inside a sentence. A badge is not a target: one
 * that links or toggles is a {@link Chip}.
 *
 * **Colour goes on the glyph, never the word.** `warning`, `error` and
 * `success` each bring their own icon in their own colour, and the word stays
 * on the neutral tint. That is what keeps every pairing at AA on every ground
 * the app has, and it means colour is never the only signal.
 *
 * @param tone - `neutral`, `warning`, `error`, `success`, or `info` (drawn
 *   neutral). Defaults to `neutral`.
 * @param size - `sm` (12px) or `xs` (11px). Defaults to `sm`.
 * @param icon - Overrides the tone's glyph; `null` removes it.
 * @param live - Draw the pulsing working dot.
 * @param asChild - Render the child element instead of a `<span>`.
 */
function Badge({
  className,
  tone,
  size = 'sm',
  icon,
  live = false,
  asChild = false,
  variant,
  shape: _shape,
  children,
  ...props
}: BadgeProps) {
  const resolved = resolveTone(tone, variant);
  const Icon = icon === undefined ? TONE_ICON[resolved] : icon;
  const Comp = asChild ? Slot.Root : 'span';

  return (
    <Comp
      data-slot="badge"
      data-tone={resolved}
      data-live={live || undefined}
      className={cn(
        badgeVariants({ size, emphasis: resolved === 'neutral' && !live ? 'quiet' : 'strong' }),
        className
      )}
      {...props}
    >
      {live && (
        <span
          aria-hidden
          data-slot="badge-live-dot"
          className={cn('bg-status-success size-1.5 shrink-0 rounded-full', STATUS_DOT_PULSE)}
        />
      )}
      {Icon && <Icon aria-hidden className={TONE_ICON_COLOR[resolved]} />}
      {asChild ? <Slot.Slottable>{children}</Slot.Slottable> : children}
    </Comp>
  );
}

export { Badge, badgeVariants };
