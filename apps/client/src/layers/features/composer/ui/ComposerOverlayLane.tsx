import { cn } from '@/layers/shared/lib';

/**
 * Every prop the composer's overlay lane accepts.
 *
 * Exported because the `Composer` namespace object in the barrel infers its
 * type from this component; it is NOT part of the slice's public surface —
 * consumers pass props at the JSX site, they never name this type.
 */
export interface ComposerOverlayLaneProps {
  /**
   * What floats above the card. Source order IS stacking order — see this
   * component's own documentation before reordering anything here.
   */
  children: React.ReactNode;
  /** Merged after the lane's own classes, so a caller can override them. */
  className?: string;
}

/**
 * The one lane above the composer card, for everything transient.
 *
 * Command palettes, file palettes, and `Composer.ClearArmedHint` all live here.
 * Chat and rooms each hand-rolled this strip with a different inset before it
 * existed. It anchors with `bottom-full` to the `relative` on `Composer.Root`,
 * so it is only ever correct inside that card.
 *
 * **Stacking order is child order.** There is no z-index logic and no
 * `AnimatePresence` of its own — hosts bring their own animation, and the lane
 * stays a single positioned `div`. Both hosts depend on this: palettes go
 * first, `Composer.ClearArmedHint` last, which puts the armed-clear pill BELOW
 * an open palette instead of across it. That case is reachable in normal use —
 * arm the clear with a bare Escape, then type `/` inside the 500ms window.
 *
 * The lane exists at all because the alternative was measured and was worse.
 * Anchoring the armed-clear hint inside the text field instead lands it
 * squarely across the bottom queue row's Send-now and Remove buttons — the one
 * way out of a queue the flush pump cannot drain. Floating the lane above the
 * whole card costs the resting composer no pixels and moves nothing when
 * something appears in it.
 */
export function ComposerOverlayLane({ children, className }: ComposerOverlayLaneProps) {
  return (
    <div className={cn('absolute right-0 bottom-full left-0 mb-2', className)}>{children}</div>
  );
}
