import { Folder, GitBranch } from 'lucide-react';
import { Badge } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { formatMarker } from '../lib/marker-labels';
import { useSpotlight } from '../lib/use-spotlight';
import type { ScanCandidate } from '../model/use-discovery-scan';

interface AgentCardProps {
  candidate: ScanCandidate;
  selected: boolean;
  onToggle: () => void;
}

/** Replace home directory prefix with ~ for compact display. */
function formatPath(path: string): string {
  return path.replace(/^\/(?:Users|home)\/[^/]+/, '~');
}

/** Extract org/repo from a git remote URL (HTTPS or SSH). */
function formatRemote(remote: string): string {
  // git@github.com:org/repo.git → org/repo
  const sshMatch = remote.match(/:([^/]+\/[^/]+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];
  // https://github.com/org/repo.git → org/repo
  const segments = remote.replace(/\.git$/, '').split('/');
  if (segments.length >= 2) return `${segments[segments.length - 2]}/${segments[segments.length - 1]}`;
  return remote;
}

/**
 * Card displaying a discovered agent project with selection toggle.
 *
 * Clicking anywhere on the card toggles selection. Shows project name,
 * truncated path, AI marker badges, and git remote when available.
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

 {/* Marker badges */}
 <div className="flex flex-wrap gap-1.5">
          {candidate.markers.map((marker) => (
            <Badge key={marker} variant="secondary" className="text-xs">
              {formatMarker(marker)}
            </Badge>
          ))}
        </div>

        <p className="flex items-center gap-1.5 truncate text-sm text-muted-foreground">
          <Folder className="size-3.5 shrink-0" />
          <span className="truncate font-mono">{formatPath(candidate.path)}</span>
        </p>

        {/* Git remote */}
        {candidate.gitRemote && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <GitBranch className="size-3 shrink-0" />
            <span className="truncate font-mono">{formatRemote(candidate.gitRemote)}</span>
          </p>
        )}
      </div>
    </button>
  );
}
