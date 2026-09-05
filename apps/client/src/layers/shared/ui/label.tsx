import * as React from 'react';
import { Label as LabelPrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

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
        'flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50',
        className
      )}
      {...props}
    />
  );
}

export { Label };
