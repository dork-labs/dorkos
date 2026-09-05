import * as React from 'react';

import { cn } from '@/layers/shared/lib/utils';
import { TOUCH_TARGET_RESPONSIVE_H } from './touch-target';

/** Props for {@link Input}. */
export interface InputProps extends React.ComponentProps<'input'> {
  /**
   * Grow to a 44px touch target below `md`, back to 36px past it.
   *
   * On by default. Turn it off for chrome that is not meant to be a thumb target
   * — a filter bar, a toolbar — where the taller box would crowd its neighbours.
   *
   * @default true
   */
  responsive?: boolean;
}

/**
 * A single-line text box.
 *
 * The text is 16px below `md` and 14px above it, which is not a style choice:
 * iOS zooms the page in on any input smaller than 16px when it takes focus.
 */
function Input({ className, type, responsive = true, ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        'file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm',
        responsive ? TOUCH_TARGET_RESPONSIVE_H : 'h-9',
        'focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]',
        'aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive',
        className
      )}
      {...props}
    />
  );
}

export { Input };
