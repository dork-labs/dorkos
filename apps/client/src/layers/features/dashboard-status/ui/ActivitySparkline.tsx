import { cn } from '@/layers/shared/lib';

interface ActivitySparklineProps {
  /** 7 daily session counts, index 0 = 6 days ago, index 6 = today. */
  data: number[];
  className?: string;
}

const BAR_WIDTH = 10;
const BAR_GAP = 4;
const CHART_HEIGHT = 30;
const MIN_BAR_HEIGHT = 1;

/**
 * Pure SVG bar sparkline for 7-day session activity.
 * No charting library — hand-drawn SVG rects with normalized heights.
 */
export function ActivitySparkline({ data, className }: ActivitySparklineProps) {
  // Avoid division by zero when all values are 0
  const max = Math.max(...data, 1);

  return (
    <svg viewBox="0 0 100 30" className={cn('text-muted-foreground', className)} aria-hidden="true">
      {data.map((value, i) => {
        const barHeight = (value / max) * CHART_HEIGHT;
        return (
          <rect
            key={i}
            x={i * (BAR_WIDTH + BAR_GAP) + 1}
            y={CHART_HEIGHT - Math.max(barHeight, MIN_BAR_HEIGHT)}
            width={BAR_WIDTH}
            height={Math.max(barHeight, MIN_BAR_HEIGHT)}
            rx={2}
            fill="currentColor"
            opacity={0.6}
          />
        );
      })}
    </svg>
  );
}
