/**
 * A pill you can dismiss — an active filter, a chosen option, a tag.
 *
 * The filter bar already drew this, but its chip was welded to
 * `FilterBarContext`, so the tasks panel — whose agent filter is not wired to
 * that context — drew the same pill again a few pixels differently (DOR-1763
 * finding 17.12). This is the presentational half, with no context to join.
 *
 * @module shared/ui/removable-chip
 */
import type { ReactNode } from 'react';
import { X as XIcon } from 'lucide-react';
import { cn } from '@/layers/shared/lib/utils';
import { Badge } from './badge';
import { Button } from './button';

/** Everything a removable chip renders. */
export interface RemovableChipProps {
  /** What the chip says. */
  children: ReactNode;
  /** Drop it. */
  onRemove: () => void;
  /**
   * What the dismiss button announces, e.g. `Remove agent filter`. Screen
   * readers hear only this, so name the thing being removed — not "Remove".
   */
  removeLabel: string;
  className?: string;
}

/**
 * A pill with an X on the end.
 *
 * @param children - What the chip says.
 * @param onRemove - Drop it.
 * @param removeLabel - What the dismiss button announces.
 */
function RemovableChip({ children, onRemove, removeLabel, className }: RemovableChipProps) {
  return (
    <Badge
      data-slot="removable-chip"
      shape="pill"
      variant="outline"
      className={cn('border-muted bg-muted/50 text-muted-foreground h-6 gap-1', className)}
    >
      {children}
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground -mr-1 size-4 rounded-full"
        aria-label={removeLabel}
      >
        <XIcon className="size-3" />
      </Button>
    </Badge>
  );
}

export { RemovableChip };
