import { Button } from '@/layers/shared/ui';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { TaskTemplateGallery } from './TaskTemplateGallery';

interface TasksEmptyStateProps {
  /** Called when the user clicks a preset card's CTA to create with that preset. */
  onCreateWithPreset: (preset: TaskTemplate) => void;
  /** Called when the user clicks "New custom schedule" to open a blank form. */
  onCreateBlank: () => void;
}

/**
 * Empty state for the Tasks panel — shows all available presets as actionable cards
 * plus a fallback to open a blank schedule form.
 *
 * Owns its vertical rhythm only. Side gutters belong to whoever mounts it — the
 * page hands it the page's gutters, the dialog hands it the dialog's — so the
 * card gallery never pays for two sets of padding at phone width.
 *
 * @param onCreateWithPreset - Called with a preset when user selects one
 * @param onCreateBlank - Called when user wants a blank schedule form
 */
export function TasksEmptyState({ onCreateWithPreset, onCreateBlank }: TasksEmptyStateProps) {
  return (
    <div className="flex flex-col items-center py-8 md:py-12">
      <h3 className="mb-2 text-lg font-medium">No schedules yet.</h3>
      <p className="text-muted-foreground mb-6 max-w-sm text-center text-sm">
        Put a skill on a timer and it runs without you.
      </p>

      <div className="w-full max-w-lg">
        <TaskTemplateGallery onSelect={onCreateWithPreset} />
      </div>

      <Button variant="ghost" className="mt-4" onClick={onCreateBlank}>
        New custom schedule
      </Button>
    </div>
  );
}
