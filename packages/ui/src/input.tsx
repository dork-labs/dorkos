import * as React from 'react';

import { cn } from './cn.js';
import { FIELD_CONTROL, FIELD_READ_ONLY } from './field-control.js';
import { TOUCH_TARGET_RESPONSIVE_H } from './touch-target.js';

/** Props for {@link Input}. */
export type InputProps = React.ComponentProps<'input'>;

/**
 * A single-line text box: 44px tall below `md`, 36px past it.
 *
 * The text is 16px below `md` and 14px above it, which is not a style choice:
 * iOS zooms the page in on any input smaller than 16px when it takes focus.
 */
function Input({ className, type, ...props }: InputProps) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        FIELD_CONTROL,
        FIELD_READ_ONLY,
        TOUCH_TARGET_RESPONSIVE_H,
        'file:text-dui-foreground placeholder:text-dui-muted-foreground selection:bg-dui-primary selection:text-dui-primary-foreground py-1 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium',
        className
      )}
      {...props}
    />
  );
}

export { Input };
