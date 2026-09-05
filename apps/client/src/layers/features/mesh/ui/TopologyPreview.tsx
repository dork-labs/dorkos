/**
 * A faded three-node sketch of what a topology looks like once agents exist.
 *
 * Rendered into `EmptyState`'s `preview` slot, so an empty Mesh panel shows the
 * shape of the thing it is missing rather than only saying it is missing.
 *
 * @module features/mesh/ui/TopologyPreview
 */
/** Mini faded topology preview for the agents empty state. */
export function TopologyPreview() {
  return (
    <div className="flex items-center justify-center gap-6">
      {/* Node 1 */}
      <div className="flex flex-col items-center gap-1">
        <div className="bg-background flex size-10 items-center justify-center rounded-lg border">
          <span className="text-sm">A</span>
        </div>
        <span className="text-muted-foreground text-3xs">frontend</span>
      </div>
      {/* Edge */}
      <div className="bg-border h-px w-8" />
      {/* Node 2 */}
      <div className="flex flex-col items-center gap-1">
        <div className="bg-background flex size-10 items-center justify-center rounded-lg border">
          <span className="text-sm">B</span>
        </div>
        <span className="text-muted-foreground text-3xs">backend</span>
      </div>
      {/* Edge */}
      <div className="bg-border h-px w-8" />
      {/* Node 3 */}
      <div className="flex flex-col items-center gap-1">
        <div className="bg-background flex size-10 items-center justify-center rounded-lg border">
          <span className="text-sm">C</span>
        </div>
        <span className="text-muted-foreground text-3xs">shared</span>
      </div>
    </div>
  );
}
