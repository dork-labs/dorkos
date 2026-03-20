import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './collapsible';

/**
 * Rounded card container for grouping related form fields.
 *
 * Accepts `className` for variants like `border-destructive/50` (danger zone).
 */
function FieldCard({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-card"
      className={cn('bg-card overflow-hidden rounded-lg border', className)}
      {...props}
    />
  );
}

/**
 * Content wrapper that applies automatic thin separators between children.
 *
 * Each direct child receives horizontal padding and vertical spacing via
 * `divide-y` and `[&>*]` selectors.
 */
function FieldCardContent({ className, ...props }: React.ComponentProps<'div'>) {
  return (
    <div
      data-slot="field-card-content"
      className={cn('divide-border divide-y [&>*]:px-4 [&>*]:py-3', className)}
      {...props}
    />
  );
}

interface CollapsibleFieldCardProps {
  /** Whether the collapsible section is expanded. */
  open: boolean;
  /** Called when the open state changes. */
  onOpenChange: (open: boolean) => void;
  /** Trigger label — text or ReactNode rendered next to the chevron. */
  trigger: React.ReactNode;
  /** Optional badge rendered beside the trigger label. */
  badge?: React.ReactNode;
  /** Content rendered inside the collapsible region. */
  children: React.ReactNode;
  /** Optional className for the outer card. */
  className?: string;
}

/**
 * Collapsible section wrapped in a FieldCard with a right-aligned ChevronDown.
 *
 * The chevron rotates -90deg when collapsed, matching Apple-style settings grouping.
 */
function CollapsibleFieldCard({
  open,
  onOpenChange,
  trigger,
  badge,
  children,
  className,
}: CollapsibleFieldCardProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div
        data-slot="collapsible-field-card"
        className={cn('bg-card overflow-hidden rounded-lg border', className)}
      >
        <CollapsibleTrigger className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium">
          <span className="flex items-center gap-2">
            {trigger}
            {badge}
          </span>
          <ChevronDown
            className={cn(
              'text-muted-foreground size-4 transition-transform',
              !open && '-rotate-90'
            )}
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="divide-border divide-y border-t">{children}</div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

export { FieldCard, FieldCardContent, CollapsibleFieldCard };
export type { CollapsibleFieldCardProps };
