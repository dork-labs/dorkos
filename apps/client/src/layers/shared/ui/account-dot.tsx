/**
 * The small colored circle that says which account a session runs on.
 *
 * @module shared/ui/account-dot
 */
import * as React from 'react';
import { cn } from '@/layers/shared/lib/utils';
import { Tooltip, TooltipContent, TooltipTrigger } from './tooltip';

/** Props for {@link AccountDot}. */
export interface AccountDotProps {
  /** The account's color, `#rrggbb`. */
  color: string;
  /** The account's name: the dot's accessible name and its tooltip. */
  name: string;
  /** `sm` is 8px (rows and chips); `md` is 10px (the palette and larger rows). */
  size?: 'sm' | 'md';
  /** Extra classes for the dot. */
  className?: string;
  /**
   * Show the name in a tooltip of its own (the default). Pass `false` where the
   * dot sits inside something that already has a tooltip, such as a sidebar
   * row: that tooltip names the account instead, so two never open at once.
   */
  tooltip?: boolean;
}

const DOT_SIZE = { sm: 'size-2', md: 'size-2.5' } as const;

/**
 * An account's color as a dot, named by its tooltip and its accessible name,
 * so color is never the only signal (spec `claude-account-ui` invariant 2).
 *
 * Not a tab stop: a screen reader reads the name in place, and where the dot
 * sits in an interactive row or chip, that control's accessible name already
 * carries the account's name. The tooltip is for a pointer. Only render it
 * where `useAccountIdentityGate` is open: with one account there is nothing to
 * tell apart.
 */
export function AccountDot({
  color,
  name,
  size = 'sm',
  className,
  tooltip = true,
}: AccountDotProps) {
  const dot = (
    <span
      role="img"
      aria-label={name}
      data-slot="account-dot"
      className={cn(
        'inline-block shrink-0 rounded-full bg-(--account-color)',
        DOT_SIZE[size],
        className
      )}
      // The one literal-color exception, as in `identity-avatar.tsx`: an
      // account's color is user data Tailwind cannot know at build time. It
      // only ever paints a dot or a badge, never a large fill.
      style={{ '--account-color': color } as React.CSSProperties}
    />
  );
  if (!tooltip) return dot;
  return (
    <Tooltip>
      <TooltipTrigger asChild>{dot}</TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
