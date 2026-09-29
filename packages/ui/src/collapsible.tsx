import { Collapsible as CollapsiblePrimitive } from 'radix-ui';

import { cn } from './cn.js';

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
 * come from the package Tailwind entry via `tw-animate-css` and read Radix's own
 * `--radix-collapsible-content-height`. Clipping is what makes the reveal read
 * as a reveal; a call site that needs something to escape the box (a popover
 * drawn inline, say) can pass `overflow-visible` and win the merge.
 *
 * **`overflow-clip`, not `overflow-hidden`, and with an 8px clip margin
 * (DOR-1751).** A host focus ring can be a `box-shadow` extending up to
 * 4px past a descendant's box; `overflow-hidden` would clip that ring when
 * an `Input` or `Button` sits at the content edge.
 * The reduced-motion override is important so it beats state-qualified
 * animation selectors in an independent consumer.
 * `overflow-clip-margin` only takes effect on `overflow: clip`, never on
 * `overflow: hidden`, which is why the utility changed too, not just the
 * margin. 8px covers the ring with room to spare and is still well inside a
 * typical panel's own padding, so nothing farther in gets a visible seam.
 */
function CollapsibleContent({
  className,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      className={cn(
        'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-clip [overflow-clip-margin:8px] motion-reduce:animate-none!',
        className
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
