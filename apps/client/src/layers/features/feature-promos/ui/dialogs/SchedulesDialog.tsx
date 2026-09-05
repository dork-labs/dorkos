import { Moon, Repeat, Clock } from 'lucide-react';
import { useTasksDeepLink } from '@/layers/shared/model';
import type { PromoDialogProps } from '../../model/promo-types';
import { PromoDialogLayout } from './PromoDialogLayout';

/** Dialog content for the Schedules promo. */
export function SchedulesDialog({ onClose }: PromoDialogProps) {
  const { open: openTasks } = useTasksDeepLink();

  const handleSetUp = () => {
    onClose();
    openTasks();
  };

  return (
    <PromoDialogLayout
      icon={Moon}
      tint="indigo"
      title="Agents that work on a schedule"
      subtitle="Put any skill on a timer"
      highlights={[
        {
          icon: Clock,
          title: 'Cron-style schedules',
          description: 'Run agents on any schedule: daily, hourly, or custom cron',
        },
        {
          icon: Repeat,
          title: 'Come back to results',
          description: 'Review completed work instead of starting it',
        },
      ]}
      primaryAction={{ label: 'Create a schedule', onClick: handleSetUp }}
      secondaryAction={{ label: 'Later', onClick: onClose }}
    />
  );
}
