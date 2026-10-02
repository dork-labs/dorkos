import * as React from 'react';
import { ChevronDown } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Collapsible, CollapsibleTrigger, CollapsibleContent } from './collapsible';

/** Props for {@link MoreDetails}. */
export interface MoreDetailsProps {
  /** The extra paragraphs. Keep each one to 15 words or fewer. */
  children: React.ReactNode;
  /** The toggle's text while the details are hidden. @default 'More details' */
  label?: string;
  /** The toggle's text while the details are shown. @default 'Fewer details' */
  openLabel?: string;
  /** Start with the details shown. @default false */
  defaultOpen?: boolean;
  /** Chrome for the wrapper: margins, width. The caller owns it. */
  className?: string;
}

/**
 * An inline "More details" toggle that reveals extra paragraphs under a description.
 *
 * Rung 3 of the overflow ladder in the `writing-app-copy` skill: the description
 * above it stays short, and the rest waits here, in the page flow, for anyone who
 * wants it. Built on `Collapsible`, so the toggle carries `aria-expanded` and
 * `aria-controls`, and the reveal and chevron both stand still under reduced
 * motion.
 *
 * Use `InfoTip` instead when the note belongs to one control rather than to a
 * block of text.
 */
export function MoreDetails({
  children,
  label = 'More details',
  openLabel = 'Fewer details',
  defaultOpen = false,
  className,
}: MoreDetailsProps) {
  const [open, setOpen] = React.useState(defaultOpen);
  return (
    <Collapsible open={open} onOpenChange={setOpen} className={cn('text-sm', className)}>
      <CollapsibleTrigger className="text-muted-foreground hover:text-foreground focus-ring -mx-1 inline-flex items-center gap-1 rounded-sm px-1 text-xs font-medium transition-colors duration-150">
        {open ? openLabel : label}
        <ChevronDown
          aria-hidden
          className={cn(
            'size-3.5 shrink-0 motion-safe:transition-transform motion-safe:duration-150',
            open && 'rotate-180'
          )}
        />
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="text-muted-foreground space-y-2 pt-1.5 leading-relaxed">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}
