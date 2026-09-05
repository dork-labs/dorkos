/**
 * Tabs — one panel visible at a time, switched by a strip of triggers.
 *
 * For the app's scrolling, overflow-aware tab strips (session chrome, settings
 * headers), use `BarTabStrip` instead; this is the plain Radix pair, right for a
 * dialog or a small panel with a handful of tabs that always fit.
 *
 * @module shared/ui/tabs
 */
import * as React from 'react';
import * as TabsPrimitive from '@radix-ui/react-tabs';

import { cn } from '@/layers/shared/lib/utils';
import { TOUCH_TARGET_RESPONSIVE_H } from './touch-target';

/** The tab set — wraps the list and its panels, and owns which one is showing. */
function Tabs({ ...props }: React.ComponentProps<typeof TabsPrimitive.Root>) {
  return <TabsPrimitive.Root data-slot="tabs" {...props} />;
}

/** Props for {@link TabsList}. */
export interface TabsListProps extends React.ComponentProps<typeof TabsPrimitive.List> {
  /**
   * Grow to a 44px touch target below `md`, back to 36px past it.
   *
   * On by default. Turn it off for chrome that is not meant to be a thumb
   * target, where the taller strip would crowd everything beside it.
   *
   * @default true
   */
  responsive?: boolean;
}

/** The strip of triggers. Arrow keys move between them, so keep them in one list. */
function TabsList({ className, responsive = true, ...props }: TabsListProps) {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn(
        'bg-muted text-muted-foreground inline-flex items-center justify-center rounded-lg p-1',
        responsive ? TOUCH_TARGET_RESPONSIVE_H : 'h-9',
        className
      )}
      {...props}
    />
  );
}

/** One tab in the strip. Its `value` is what pairs it with a {@link TabsContent}. */
function TabsTrigger({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'ring-offset-background inline-flex items-center justify-center rounded-md px-3 py-1.5 text-sm font-medium whitespace-nowrap transition-[color,background-color,box-shadow,opacity] md:py-1',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        'disabled:pointer-events-none disabled:opacity-50',
        'data-[state=active]:bg-background data-[state=active]:text-foreground data-[state=active]:shadow',
        className
      )}
      {...props}
    />
  );
}

/** One panel. Only the active one is mounted, so it fades in without a partner fading out. */
function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn(
        'ring-offset-background mt-2',
        // Enter only, no exit: the panel it replaces is already unmounted, so
        // there is never a moment with two panels on screen. 150ms, the in-page
        // transition row of the duration table.
        'data-[state=active]:animate-in data-[state=active]:fade-in-0 data-[state=active]:duration-150',
        'focus-visible:ring-ring focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none',
        className
      )}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
