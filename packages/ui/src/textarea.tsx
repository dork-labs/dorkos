import * as React from 'react';

import { cn } from './cn.js';
import { FIELD_CONTROL, FIELD_READ_ONLY } from './field-control.js';

/**
 * A multi-line text box.
 *
 * No `responsive` prop, unlike its siblings, and that is a decision rather than
 * an omission: `min-h-15` already clears the 44px touch target at every width, so
 * there is nothing to grow into. The text still steps from 16px to 14px past `md`
 * for the same reason `Input` does: iOS zooms the page in on any smaller input
 * that takes focus.
 */
function Textarea({ className, ...props }: React.ComponentProps<'textarea'>) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        FIELD_CONTROL,
        FIELD_READ_ONLY,
        'placeholder:text-dui-muted-foreground flex min-h-15 py-2',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
