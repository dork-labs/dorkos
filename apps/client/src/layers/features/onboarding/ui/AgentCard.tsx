import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { formatMarker } from '../lib/marker-labels';
import { useSpotlight } from '../lib/use-spotlight';
import type { ScanCandidate } from '../model/use-discovery-scan';

interface AgentCardProps {
  candidate: ScanCandidate & { hasDorkManifest: boolean };
  selected: boolean;
  onToggle: () => void;
}

/**
 * Card displaying a discovered agent project with selection toggle.
 *
 * Clicking anywhere on the card toggles selection. Shows project name,
 * truncated path, AI marker badges, and git branch when available.
 * Features a mouse-tracking spotlight effect on hover.
 */
export function AgentCard({ candidate, selected, onToggle }: AgentCardProps) {
  const { onMouseMove, onMouseLeave, spotlightStyle } = useSpotlight();

  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={cn(
        'relative flex w-full items-start gap-4 rounded-xl border p-6 text-left transition-colors',
        'hover:bg-muted/50',
        selected ? 'border-primary bg-primary/5' : 'border-border'
      )}
    >
      {/* Spotlight overlay */}
      {spotlightStyle && (
        <div
          className="pointer-events-none absolute inset-0 rounded-xl"
          style={spotlightStyle}
        />
      )}

      {/* Selection checkbox — 44px touch target wrapping the visual checkbox */}
      <div className="mt-0.5 flex size-11 flex-shrink-0 items-center justify-center">
        <div
          className={cn(
            'flex size-5 items-center justify-center rounded border-2 transition-colors',
            selected
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/40'
          )}
        >
          {selected && (
            <svg
              className="size-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          )}
        </div>
      </div>

      {/* Card content */}
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-center gap-2">
          <span className="text-lg font-semibold">{candidate.name}</span>
          {candidate.hasDorkManifest && (
            <Badge variant="secondary" className="text-xs">
              Registered
            </Badge>
          )}
        </div>

        <p className="truncate text-sm text-muted-foreground">{candidate.path}</p>

        {/* Marker badges */}
        <div className="flex flex-wrap gap-1.5">
          {candidate.markers.map((marker) => (
            <Badge key={marker} variant="secondary" className="text-xs">
              {formatMarker(marker)}
            </Badge>
          ))}
        </div>

        {/* Git branch */}
        {candidate.gitBranch && (
          <p className="text-xs text-muted-foreground">
            <span className="font-mono">{candidate.gitBranch}</span>
          </p>
        )}
      </div>
    </button>
  );
}
