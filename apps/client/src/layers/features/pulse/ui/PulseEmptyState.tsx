import { Button } from '@/layers/shared/ui';
import type { PulsePreset } from '@/layers/entities/pulse';
import { PresetGallery } from './PresetGallery';

interface PulseEmptyStateProps {
  /** Called when the user clicks a preset card's CTA to create with that preset. */
  onCreateWithPreset: (preset: PulsePreset) => void;
  /** Called when the user clicks "New custom schedule" to open a blank form. */
  onCreateBlank: () => void;
}

/**
 * Empty state for the Pulse panel — shows all available presets as actionable cards
 * plus a fallback to open a blank schedule form.
 *
 * @param onCreateWithPreset - Called with a preset when user selects one
 * @param onCreateBlank - Called when user wants a blank schedule form
 */
export function PulseEmptyState({ onCreateWithPreset, onCreateBlank }: PulseEmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-8 md:py-12">
      <h3 className="mb-2 text-lg font-medium">No schedules yet.</h3>
      <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
        Automate your workflows with Pulse.
      </p>

      <div className="w-full max-w-lg">
        <PresetGallery onSelect={onCreateWithPreset} />
      </div>

      <Button variant="ghost" className="mt-4" onClick={onCreateBlank}>
        New custom schedule
      </Button>
    </div>
  );
}
