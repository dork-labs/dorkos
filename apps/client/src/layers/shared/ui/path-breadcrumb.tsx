import { ChevronRight } from 'lucide-react';

interface PathBreadcrumbProps {
  /** Absolute path to display */
  path: string | null;
  /** Max segments to show; earlier segments are replaced with "..." */
  maxSegments?: number;
  /** When provided, each segment becomes a clickable button that receives the full path up to that segment */
  onSegmentClick?: (segmentPath: string) => void;
  /** Text size variant */
  size?: 'sm' | 'md';
}

export function PathBreadcrumb({
  path,
  maxSegments,
  onSegmentClick,
  size = 'md',
}: PathBreadcrumbProps) {
  if (!path) return null;

  const allSegments = path.split('/').filter(Boolean);
  const truncated = maxSegments != null && allSegments.length > maxSegments;
  const visible = truncated ? allSegments.slice(-maxSegments) : allSegments;
  // Offset into allSegments where visible starts
  const offset = allSegments.length - visible.length;

  const textClass = size === 'sm' ? 'text-2xs' : 'text-xs';
  const chevronClass = 'size-(--size-icon-xs)';
  const maxWidth = size === 'sm' ? 'max-w-[80px]' : 'max-w-[120px]';

  return (
    <div className="flex items-center gap-0.5 min-w-0 overflow-hidden">
      {truncated && (
        <>
          <span className={`${textClass} text-muted-foreground/50 flex-shrink-0`}>...</span>
          <ChevronRight className={`${chevronClass} text-muted-foreground/40 flex-shrink-0`} />
        </>
      )}
      {visible.map((segment, i) => {
        const globalIndex = offset + i;
        const segPath = '/' + allSegments.slice(0, globalIndex + 1).join('/');
        const isLast = globalIndex === allSegments.length - 1;

        const labelClass = `${textClass} truncate ${maxWidth} ${
          isLast ? 'font-medium text-foreground' : 'text-muted-foreground'
        }`;

        return (
          <span key={segPath} className={`flex items-center ${isLast ? 'flex-shrink-0' : 'min-w-0'}`}>
            {i > 0 && (
              <ChevronRight className={`${chevronClass} text-muted-foreground/40 flex-shrink-0`} />
            )}
            {onSegmentClick ? (
              <button
                onClick={() => onSegmentClick(segPath)}
                className={`px-1 py-0.5 rounded hover:bg-accent transition-colors ${labelClass}`}
              >
                {segment}
              </button>
            ) : (
              <span className={labelClass}>{segment}</span>
            )}
          </span>
        );
      })}
    </div>
  );
}
