import { Moon, Repeat, Clock } from 'lucide-react';
import { Button } from '@/layers/shared/ui';
import { useTasksDeepLink } from '@/layers/shared/model';
import type { PromoDialogProps } from '../../model/promo-types';

/** Dialog content for the Schedules promo. */
export function SchedulesDialog({ onClose }: PromoDialogProps) {
  const { open: openTasks } = useTasksDeepLink();

  const handleSetUp = () => {
    onClose();
    openTasks();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div className="flex size-10 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500/10 to-indigo-600/10">
          <Moon className="size-5 text-indigo-500" />
        </div>
        <div>
          <h3 className="text-sm font-medium">Agents that work while you sleep</h3>
          <p className="text-muted-foreground text-xs">Schedule recurring tasks with Tasks</p>
        </div>
      </div>

      <div className="bg-muted/50 space-y-3 rounded-lg p-4">
        <div className="flex items-start gap-3">
          <Clock className="text-muted-foreground mt-0.5 size-4" />
          <div>
            <p className="text-xs font-medium">Cron-style schedules</p>
            <p className="text-muted-foreground text-xs">
              Run agents on any schedule &mdash; daily, hourly, or custom cron
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3">
          <Repeat className="text-muted-foreground mt-0.5 size-4" />
          <div>
            <p className="text-xs font-medium">Wake up to results</p>
            <p className="text-muted-foreground text-xs">
              Review completed work in the morning, not start it
            </p>
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={onClose}>
          Later
        </Button>
        <Button size="sm" onClick={handleSetUp}>
          Create a schedule
        </Button>
      </div>
    </div>
  );
}
