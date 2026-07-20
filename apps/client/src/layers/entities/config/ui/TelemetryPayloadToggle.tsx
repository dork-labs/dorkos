import { ChevronDown } from 'lucide-react';

import { cn } from '@/layers/shared/lib';

interface TelemetryPayloadToggleProps {
  /** Whether the payload region this toggle controls is expanded. */
  open: boolean;
  /** Flip the expanded state. */
  onToggle: () => void;
  /** Optional classes for the button. */
  className?: string;
}

/**
 * The "See what's sent" progressive-disclosure toggle — a text link with a
 * chevron that flips when the payload is open. Presentational and controlled;
 * the caller owns the open state and the region being revealed. Shared so the
 * consent banner and the standalone {@link TelemetryPayloadDisclosure} offer the
 * exact same affordance.
 *
 * @param open - Whether the controlled payload region is expanded.
 * @param onToggle - Flip the expanded state.
 * @param className - Optional classes for the button.
 */
export function TelemetryPayloadToggle({ open, onToggle, className }: TelemetryPayloadToggleProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        'text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm text-xs font-medium underline underline-offset-2 outline-none hover:no-underline focus-visible:ring-2',
        className
      )}
    >
      See what&apos;s sent
      <ChevronDown
        aria-hidden
        className={cn('size-3 transition-transform duration-200', open && 'rotate-180')}
      />
    </button>
  );
}
