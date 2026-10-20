import { ArrowLeftRight } from 'lucide-react';

/**
 * One quiet line saying every agent may message every other (DOR-3154).
 *
 * The open-mesh rule (`*` -> `*`) names no namespace, so the map draws no edge
 * for it; this line is how the map says it is on. It is a statement, not a
 * control: the switch lives in Access. With the rule off, nothing renders.
 */
export function OpenMeshNote() {
  return (
    <p className="text-muted-foreground pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-1.5 text-xs">
      <ArrowLeftRight aria-hidden className="size-5 shrink-0 sm:size-4" />
      Everyone can message everyone
    </p>
  );
}
