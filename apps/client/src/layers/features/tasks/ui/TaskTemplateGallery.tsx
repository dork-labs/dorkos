import { cn } from '@/layers/shared/lib';
import { useTaskTemplates } from '@/layers/entities/tasks';
import type { TaskTemplate } from '@/layers/entities/tasks';
import { TaskTemplateCard } from './TaskTemplateCard';

interface TaskTemplateGalleryProps {
  /** Called when the user selects a preset card. */
  onSelect?: (preset: TaskTemplate) => void;
  /** ID of the currently selected preset, if any. */
  selectedId?: string;
  /** Additional class names for the gallery container. */
  className?: string;
}

/**
 * Responsive 2-column grid of all available Tasks presets in selectable variant.
 *
 * Handles loading (skeleton grid) and error states internally.
 * Uses the shared `useTaskTemplates` query — cached under ['tasks', 'templates'].
 *
 * @param onSelect - Called with the chosen preset when a card is clicked
 * @param selectedId - The id of the currently selected preset
 */
export function TaskTemplateGallery({ onSelect, selectedId, className }: TaskTemplateGalleryProps) {
  const { data: presets, isLoading, isError } = useTaskTemplates();

  if (isLoading) {
    return (
      <div className={cn('grid grid-cols-2 gap-3', className)}>
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="bg-muted animate-breath h-28 rounded-lg border" />
        ))}
      </div>
    );
  }

  if (isError) {
    return (
      <p className="text-destructive text-sm">
        Couldn&rsquo;t load the ready-made tasks. You can still start from scratch.
      </p>
    );
  }

  if (!presets || presets.length === 0) {
    return <p className="text-muted-foreground text-sm">No presets available.</p>;
  }

  return (
    <div className={cn('grid grid-cols-2 gap-3', className)}>
      {presets.map((preset) => (
        <TaskTemplateCard
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
