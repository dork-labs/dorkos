import { Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { PulsePreset } from '../model/use-pulse-presets';
import { formatCron } from '../lib/format-cron';
import { useSpotlight } from '../lib/use-spotlight';

interface PresetCardProps {
  preset: PulsePreset;
  enabled: boolean;
  onToggle: () => void;
}

/**
 * Card displaying a Pulse schedule preset with a toggle switch.
 * Features a mouse-tracking spotlight effect on hover.
 *
 * @param preset - The preset data to display
 * @param enabled - Whether this preset is currently enabled
 * @param onToggle - Called when the toggle switch is clicked
 */
export function PresetCard({ preset, enabled, onToggle }: PresetCardProps) {
  const { onMouseMove, onMouseLeave, spotlightStyle } = useSpotlight();

  return (
    <button
      type="button"
      onClick={onToggle}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={cn(
        'relative flex w-full items-start gap-4 rounded-lg border p-4 text-left transition',
        'hover:bg-accent/50',
        'min-h-11',
        enabled && 'border-primary/40 bg-accent/30'
      )}
    >
      {/* Spotlight overlay */}
      {spotlightStyle && (
        <div
          className="pointer-events-none absolute inset-0 rounded-lg"
          style={spotlightStyle}
        />
      )}

      {/* Switch wrapper with 44px touch target */}
      <div className="flex size-11 shrink-0 items-center justify-center">
        <Switch
          checked={enabled}
          onCheckedChange={onToggle}
          aria-label={`Enable ${preset.name}`}
          onClick={(e) => e.stopPropagation()}
        />
      </div>

      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium">{preset.name}</div>
        <p className="text-sm text-muted-foreground">{preset.description}</p>
        <p className="text-xs text-muted-foreground">
          {formatCron(preset.cron)}
        </p>
        <p className="line-clamp-2 text-sm text-muted-foreground/80">
          {preset.prompt}
        </p>
      </div>
    </button>
  );
}
