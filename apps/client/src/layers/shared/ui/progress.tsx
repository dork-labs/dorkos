import * as React from 'react';
import { cn } from '../lib/utils';

interface ProgressProps extends React.ComponentProps<'div'> {
  /** Completion percentage, clamped to 0–100. */
  value?: number;
}

/**
 * Determinate progress bar. Div-based (no Radix dependency) — the fill width is
 * a dynamic value, so it rides an inline style while all color/shape comes from
 * theme tokens.
 */
function Progress({ value = 0, className, ...props }: ProgressProps) {
  const pct = Math.min(100, Math.max(0, value));
  return (
    <div
      data-slot="progress"
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className={cn('bg-secondary relative h-2 w-full overflow-hidden rounded-full', className)}
      {...props}
    >
      <div
        data-slot="progress-indicator"
        className="bg-primary h-full rounded-full transition-all"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

export { Progress };
