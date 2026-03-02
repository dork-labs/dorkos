import { useState, useCallback } from 'react';
import { Button } from '@/layers/shared/ui';
import { useCreateSchedule } from '@/layers/entities/pulse';
import { usePulsePresets } from '../model/use-pulse-presets';
import { PresetCard } from './PresetCard';

interface PulsePresetsStepProps {
  onStepComplete: () => void;
}

/**
 * Onboarding step for selecting recurring Pulse schedule presets.
 * Displays available presets with toggles and a confirmation button.
 *
 * @param onStepComplete - Called when the user finishes selecting presets
 */
export function PulsePresetsStep({ onStepComplete }: PulsePresetsStepProps) {
  const { data: presets, isLoading, isError } = usePulsePresets();
  const createSchedule = useCreateSchedule();
  const [enabledPresets, setEnabledPresets] = useState<Set<string> | null>(
    null
  );
  const [isCreating, setIsCreating] = useState(false);

  // Initialize enabledPresets with all preset IDs once data loads
  const resolvedEnabled =
    enabledPresets ?? new Set(presets?.map((p) => p.id) ?? []);

  const handleToggle = useCallback(
    (id: string) => {
      setEnabledPresets((prev) => {
        const current = prev ?? new Set(presets?.map((p) => p.id) ?? []);
        const next = new Set(current);
        if (next.has(id)) {
          next.delete(id);
        } else {
          next.add(id);
        }
        return next;
      });
    },
    [presets]
  );

  const selectedCount = resolvedEnabled.size;

  const handleCreateSchedules = useCallback(async () => {
    if (!presets || selectedCount === 0) {
      onStepComplete();
      return;
    }

    setIsCreating(true);
    const selected = presets.filter((p) => resolvedEnabled.has(p.id));
    try {
      await Promise.all(
        selected.map((preset) =>
          createSchedule.mutateAsync({
            name: preset.name,
            prompt: preset.prompt,
            cron: preset.cron,
          })
        )
      );
    } catch {
      // Continue even if some creations fail — schedules can be created later
    } finally {
      setIsCreating(false);
      onStepComplete();
    }
  }, [presets, selectedCount, resolvedEnabled, createSchedule, onStepComplete]);

  return (
    <div className="mx-auto w-full max-w-2xl space-y-8 px-4">
      <div className="space-y-2 text-center">
        <h2 className="text-2xl font-semibold tracking-tight">
          Want your agents to work while you sleep?
        </h2>
        <p className="text-sm text-muted-foreground">
          Pulse runs automated tasks on a schedule — like a cron job for your agents.
        </p>
      </div>

      {isLoading && (
        <p className="text-center text-sm text-muted-foreground">
          Loading presets...
        </p>
      )}

      {isError && (
        <p className="text-center text-sm text-destructive">
          Failed to load presets. You can skip this step and configure schedules
          later.
        </p>
      )}

      {presets && presets.length > 0 && (
        <div className="grid gap-3">
          {presets.map((preset) => (
            <PresetCard
              key={preset.id}
              preset={preset}
              enabled={resolvedEnabled.has(preset.id)}
              onToggle={() => handleToggle(preset.id)}
            />
          ))}
        </div>
      )}

      <div className="flex flex-col items-center gap-3 pt-2">
        <Button onClick={handleCreateSchedules} size="lg" disabled={isCreating}>
          {isCreating
            ? 'Creating...'
            : selectedCount > 0
              ? `Create ${selectedCount} Schedule${selectedCount === 1 ? '' : 's'}`
              : 'Continue Without Schedules'}
        </Button>
        {selectedCount > 0 && (
          <p className="text-xs text-muted-foreground">
            {selectedCount} preset{selectedCount === 1 ? '' : 's'} selected
          </p>
        )}
      </div>
    </div>
  );
}
