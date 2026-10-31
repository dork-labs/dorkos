import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';

import { cn } from './cn.js';

/**
 * The name of a control, tied to it so a click on the words focuses the input.
 *
 * Dims itself when the control it labels is disabled — through `peer-disabled:`
 * for a sibling input and `group-data-[disabled=true]:` for a `Field` wrapper —
 * so a row never reads as active while the thing it names is not.
 */
function Label({ className, ...props }: React.ComponentProps<typeof LabelPrimitive.Root>) {
  return (
    <LabelPrimitive.Root
      data-slot="label"
      className={cn(
        'group-data-[disabled=true]:text-dui-muted-foreground peer-disabled:text-dui-muted-foreground flex items-center gap-2 text-sm font-medium select-none group-data-[disabled=true]:pointer-events-none peer-disabled:cursor-not-allowed',
        className
      )}
      {...props}
    />
  );
}

export { Label };
