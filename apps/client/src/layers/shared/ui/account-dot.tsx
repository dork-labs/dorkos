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
}

const DOT_SIZE = { sm: 'size-2', md: 'size-2.5' } as const;

/**
 * An account's color as a dot, named by its tooltip and its accessible name,
 * so color is never the only signal (spec `claude-account-ui` invariant 2).
 *
 * Focusable so the name reaches a keyboard as well as a pointer. Only render it
 * where `useAccountIdentityGate` is open: with one account there is nothing to
 * tell apart.
 */
export function AccountDot({ color, name, size = 'sm', className }: AccountDotProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          role="img"
          aria-label={name}
          // A tab stop, so a keyboard reaches the tooltip as a pointer does.
          // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a tooltip trigger, focusable by design
          tabIndex={0}
          data-slot="account-dot"
          className={cn(
            'focus-visible:ring-ring inline-block shrink-0 rounded-full bg-(--account-color) outline-none focus-visible:ring-2 focus-visible:ring-offset-1',
            DOT_SIZE[size],
            className
          )}
          // The one literal-color exception, as in `identity-avatar.tsx`: an
          // account's color is user data Tailwind cannot know at build time. It
          // only ever paints a dot or a badge, never a large fill.
          style={{ '--account-color': color } as React.CSSProperties}
        />
      </TooltipTrigger>
      <TooltipContent>{name}</TooltipContent>
    </Tooltip>
  );
}
