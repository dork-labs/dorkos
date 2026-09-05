'use client';

import * as React from 'react';
import { Separator as SeparatorPrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

/**
 * A hairline between two groups of content, horizontal or vertical.
 *
 * `decorative` defaults to true, which keeps the line out of the accessibility
 * tree — the right answer when the rule is only reinforcing a gap a sighted
 * reader can already see. Pass `decorative={false}` when the line is the only
 * thing marking a real boundary, so a screen reader announces it too.
 */
function Separator({
  className,
  orientation = 'horizontal',
  decorative = true,
  ...props
}: React.ComponentProps<typeof SeparatorPrimitive.Root>) {
  return (
    <SeparatorPrimitive.Root
      data-slot="separator"
      decorative={decorative}
      orientation={orientation}
      className={cn(
        'bg-border shrink-0 data-[orientation=horizontal]:h-px data-[orientation=horizontal]:w-full data-[orientation=vertical]:h-full data-[orientation=vertical]:w-px',
        className
      )}
      {...props}
    />
  );
}

export { Separator };
