'use client';

import * as React from 'react';
import { cva } from 'class-variance-authority';
import { useIsMobile } from '../model';
import { cn } from '@/layers/shared/lib/utils';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from './sheet';

/**
 * Width variants for {@link ResponsiveSheetContent}. Desktop docks the panel
 * at a fixed reading width; a phone (`useIsMobile`, 768px breakpoint) widens
 * it to fill the screen instead of the base Sheet's `w-3/4` default, which on
 * a phone would still leave a visible strip of the page down one side.
 */
const responsiveSheetContentVariants = cva('', {
  variants: {
    isMobile: {
      true: 'w-full sm:max-w-full',
      false: 'sm:max-w-md',
    },
  },
  defaultVariants: {
    isMobile: false,
  },
});

/**
 * Content panel for a right-side sheet that goes full-screen on a phone.
 *
 * `side` is always `"right"` — this primitive exists for right-side panels
 * only, generalized from `RightPanelContainer.tsx:205-224`'s hand-rolled
 * version; the profile drawer (`specs/identity-consistency/02-specification.md`
 * §W3.2) is the second consumer. A
 * caller's `className` is applied last, so it can still override the
 * computed width where a fixed width is wanted regardless of viewport.
 */
function ResponsiveSheetContent({
  className,
  ...props
}: Omit<React.ComponentProps<typeof SheetContent>, 'side'>) {
  const isMobile = useIsMobile();
  return (
    <SheetContent
      side="right"
      className={cn(responsiveSheetContentVariants({ isMobile }), className)}
      {...props}
    />
  );
}

export {
  Sheet as ResponsiveSheet,
  SheetTrigger as ResponsiveSheetTrigger,
  SheetClose as ResponsiveSheetClose,
  SheetHeader as ResponsiveSheetHeader,
  SheetFooter as ResponsiveSheetFooter,
  SheetTitle as ResponsiveSheetTitle,
  SheetDescription as ResponsiveSheetDescription,
  ResponsiveSheetContent,
  responsiveSheetContentVariants,
};
