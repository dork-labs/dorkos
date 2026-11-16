import { Coins } from 'lucide-react';
import { cn } from '@/layers/shared/lib';

/** Props for {@link PaidActionMarker}. */
export interface PaidActionMarkerProps {
  /**
   * `pill` is the icon and its words on a muted pill (lists, the card).
   * `icon` is the icon alone, named for screen readers (the end of a chip).
   * `line` is the icon and its words as a muted line (an app row, a legend).
   */
  variant?: 'pill' | 'icon' | 'line';
  /** The words beside the icon. Defaults to "Spends money". */
  label?: string;
  /** Extra classes for the outer element. */
  className?: string;
}

/**
 * The "Spends money" marker (DOR-4204 spec §6): a muted Coins icon and its
 * words, wherever an action that spends money is named. A fact about the
 * action, like "Look", so it is never warning-toned and never colour alone.
 */
export function PaidActionMarker({
  variant = 'pill',
  label = 'Spends money',
  className,
}: PaidActionMarkerProps) {
  if (variant === 'icon') {
    return (
      <Coins
        role="img"
        aria-label="spends money"
        className={cn('text-muted-foreground size-3.5 shrink-0 max-sm:size-5', className)}
      />
    );
  }
  return (
    <span
      data-slot="paid-action-marker"
      className={cn(
        'text-muted-foreground inline-flex items-center gap-1 text-xs',
        variant === 'pill' && 'bg-muted rounded-full px-2 py-0',
        className
      )}
    >
      <Coins className="size-3.5 shrink-0 max-sm:size-5" aria-hidden />
      {label}
    </span>
  );
}
