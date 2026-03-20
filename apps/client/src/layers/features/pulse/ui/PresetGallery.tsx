import { cn } from '@/layers/shared/lib';
import { usePulsePresets } from '@/layers/entities/pulse';
import type { PulsePreset } from '@/layers/entities/pulse';
import { PresetCard } from './PresetCard';

interface PresetGalleryProps {
  /** Called when the user selects a preset card. */
  onSelect?: (preset: PulsePreset) => void;
  /** ID of the currently selected preset, if any. */
  selectedId?: string;
  /** Additional class names for the gallery container. */
  className?: string;
}

/**
 * Responsive 2-column grid of all available Pulse presets in selectable variant.
 *
 * Handles loading (skeleton grid) and error states internally.
 * Uses the shared `usePulsePresets` query — cached under ['pulse', 'presets'].
 *
 * @param onSelect - Called with the chosen preset when a card is clicked
 * @param selectedId - The id of the currently selected preset
 */
export function PresetGallery({ onSelect, selectedId, className }: PresetGalleryProps) {
  const { data: presets, isLoading, isError } = usePulsePresets();

  if (isLoading) {
    return (
      <div className={cn('grid grid-cols-2 gap-3', className)}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-muted h-28 animate-pulse rounded-lg border" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-destructive text-sm">
        Failed to load presets. You can start from scratch.
      </p>
    );
  }

  if (!presets || presets.length === 0) {
    return <p className="text-muted-foreground text-sm">No presets available.</p>;
  }

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      {presets.map((preset) => (
        <PresetCard
          key={preset.id}
          preset={preset}
          variant="selectable"
          selected={preset.id === selectedId}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
