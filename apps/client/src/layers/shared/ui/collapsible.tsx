import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

import { cn } from '@/layers/shared/lib/utils';

/** Accessible collapsible container that expands and collapses its content. */
function Collapsible({ ...props }: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  return <CollapsiblePrimitive.Root data-slot="collapsible" {...props} />;
}

/** Interactive element that toggles the collapsible open or closed. */
function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

/**
 * Content region that is shown or hidden based on the collapsible state.
 *
 * It grows and shrinks over 200ms instead of teleporting — the two keyframes
 * live in `index.css` and read Radix's own
 * `--radix-collapsible-content-height`. `overflow-hidden` is what makes the
 * reveal read as a reveal; a call site that needs something to escape the box
 * (a popover drawn inline, say) can pass `overflow-visible` and win the merge.
 */
function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-hidden',
        className
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
