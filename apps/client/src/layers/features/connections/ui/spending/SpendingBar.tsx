import { useState } from 'react';
import { cn } from '@/layers/shared/lib';

/**
 * The Spending block's bar (DOR-4204 spec §2.1, §10, §11). One tone at every
 * level, since thresholds change the words, never the colour. The fill moves
 * by `scaleX`, and only once its value changes: the bar arrives drawn rather
 * than animating history in.
 */
export function SpendingBar({ percent, valueText }: { percent: number; valueText: string }) {
  const [firstPercent] = useState(percent);
  const [moved, setMoved] = useState(false);
  if (!moved && percent !== firstPercent) setMoved(true);
  return (
    <div
      role="progressbar"
      aria-label="Spending limit used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={valueText}
      className="bg-muted h-2 w-full overflow-hidden rounded-full"
    >
      <div
        data-slot="spending-bar-fill"
        className={cn(
          'bg-foreground/80 h-full w-full origin-left rounded-full',
          moved && 'transition-transform duration-200 ease-out motion-reduce:transition-none'
        )}
        style={{ transform: `scaleX(${percent / 100})` }}
      />
    </div>
  );
}
