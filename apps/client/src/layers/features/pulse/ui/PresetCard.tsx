import { Switch } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import type { PulsePreset } from '@/layers/entities/pulse';
import { formatCron } from './format-cron';
import { useSpotlight } from './use-spotlight';

interface PresetCardProps {
  /** The preset to display */
  preset: PulsePreset;
  /** Interaction variant: toggle switch (onboarding) or click-to-select (dialog/gallery) */
  variant: 'toggle' | 'selectable';
  /** For variant='toggle': controlled checked state */
  checked?: boolean;
  /** For variant='toggle': called on toggle change */
  onCheckedChange?: (checked: boolean) => void;
  /** For variant='selectable': called when card is clicked */
  onSelect?: (preset: PulsePreset) => void;
  /** For variant='selectable': whether this card is currently selected */
  selected?: boolean;
  /** Additional class names */
  className?: string;
}

/**
 * Card displaying a Pulse schedule preset.
 *
 * Two variants:
 * - `toggle`: shows a Switch control, used in onboarding.
 * - `selectable`: click-to-select with a selection ring, used in dialog picker and empty states.
 *
 * Features a mouse-tracking spotlight effect on hover.
 *
 * @param preset - The preset data to display
 * @param variant - Controls which interaction style is rendered
 * @param checked - For toggle variant: controlled checked state
 * @param onCheckedChange - For toggle variant: called on toggle change
 * @param onSelect - For selectable variant: called when card is clicked
 * @param selected - For selectable variant: whether this card is currently selected
 */
export function PresetCard({
  preset,
  variant,
  checked,
  onCheckedChange,
  onSelect,
  selected = false,
  className,
}: PresetCardProps) {
  const { onMouseMove, onMouseLeave, spotlightStyle } = useSpotlight();

  const handleClick = () => {
    if (variant === 'toggle') {
      onCheckedChange?.(!checked);
    } else {
      onSelect?.(preset);
    }
  };

  return (
    <button
      type="button"
      onClick={handleClick}
      onMouseMove={onMouseMove}
      onMouseLeave={onMouseLeave}
      className={cn(
        'relative flex w-full items-start gap-4 rounded-lg border p-4 text-left transition',
        'hover:bg-accent/50',
        'min-h-11',
        variant === 'toggle' && checked && 'border-primary/40 bg-accent/30',
        variant === 'selectable' && selected && 'border-primary ring-primary bg-accent/30 ring-1',
        className
      )}
    >
      {/* Spotlight overlay */}
      {spotlightStyle && (
        <div className="pointer-events-none absolute inset-0 rounded-lg" style={spotlightStyle} />
      )}

      {/* Toggle switch — only for toggle variant */}
      {variant === 'toggle' && (
        <div className="flex size-11 shrink-0 items-center justify-center">
          <Switch
            checked={checked ?? false}
            onCheckedChange={onCheckedChange}
            aria-label={`Enable ${preset.name}`}
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      <div className="min-w-0 flex-1 space-y-1">
        <div className="font-medium">{preset.name}</div>
        <p className="text-muted-foreground text-sm">{preset.description}</p>
        <p className="text-muted-foreground text-xs">{formatCron(preset.cron)}</p>
        <p className="text-muted-foreground/80 line-clamp-2 text-sm">{preset.prompt}</p>
      </div>
    </button>
  );
}
