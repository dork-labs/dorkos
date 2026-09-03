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
 * come from `tw-animate-css` (imported in `index.css`) and read Radix's own
 * `--radix-collapsible-content-height`. Clipping is what makes the reveal read
 * as a reveal; a call site that needs something to escape the box (a popover
 * drawn inline, say) can pass `overflow-visible` and win the merge.
 *
 * **`overflow-clip`, not `overflow-hidden`, and with an 8px clip margin
 * (DOR-1751).** The app's focus ring is a `box-shadow`
 * (`apps/client/src/index.css`'s `focus-ring` utility, up to 4px past the
 * element's edge), not an `outline`, so a focusable descendant whose box
 * touches this content box — an `Input` or `Button` in a flush-edge row, which
 * several settings panels are — had its ring cut on every side it touched.
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
        'data-[state=closed]:animate-collapsible-up data-[state=open]:animate-collapsible-down overflow-clip [overflow-clip-margin:8px]',
        className
      )}
      {...props}
    />
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };
