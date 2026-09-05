import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
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
  /**
   * Optional control in the header, beside the chevron — a copy button, a
   * reset. Rendered OUTSIDE the trigger, never inside it: a button nested in a
   * button is invalid HTML, and the inner one would toggle the section on every
   * click. Keep it to one control; the header is not a toolbar.
   */
  action?: React.ReactNode;
  /** Content rendered inside the collapsible region. */
  children: React.ReactNode;
  /** Optional className for the outer card. */
  className?: string;
}

/**
 * Collapsible section wrapped in a FieldCard with a right-aligned ChevronDown.
 *
 * The chevron rotates -90deg when collapsed, matching Apple-style settings grouping.
 *
 * The chevron is a sibling of `CollapsibleTrigger`, not a child of it — deliberately,
 * and not merely alongside `action` because `action` has to be. Nested inside the
 * trigger, its own `justify-between` measured the chevron against the TRIGGER's box,
 * which is only as wide as the row minus whatever `action` took — so two stacked
 * cards, one with an `action` and one without, drew their chevrons at two different
 * distances from the shared right edge (review nit: measured 34px apart at 1440px).
 * Out here, both chevrons sit at the same `pr-3` from the card's own edge every time,
 * present or not.
 */
function CollapsibleFieldCard({
  open,
  onOpenChange,
  trigger,
  badge,
  action,
  children,
  className,
}: CollapsibleFieldCardProps) {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      {/* The frame is `FieldCard` itself, not a copy of its class string — a
          collapsible field card IS a field card, so the surface is stated once.
          The distinct `data-slot` still names this one. */}
      <FieldCard data-slot="collapsible-field-card" className={className}>
        <div className="flex items-center">
          <CollapsibleTrigger className="flex flex-1 items-center px-4 py-3 text-sm font-medium">
            <span className="flex items-center gap-2">
              {trigger}
              {badge}
            </span>
          </CollapsibleTrigger>
          <div className="flex shrink-0 items-center gap-1 pr-3">
            {action}
            <ChevronDown
              className={cn(
                'text-muted-foreground size-4 transition-transform',
                !open && '-rotate-90'
              )}
            />
          </div>
        </div>
        <CollapsibleContent>
          <FieldCardContent className="border-t">{children}</FieldCardContent>
        </CollapsibleContent>
      </FieldCard>
    </Collapsible>
  );
}

export { FieldCard, FieldCardContent, CollapsibleFieldCard };
export type { CollapsibleFieldCardProps };
