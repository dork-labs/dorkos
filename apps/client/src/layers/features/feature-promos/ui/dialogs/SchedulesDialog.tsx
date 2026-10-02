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
          title: 'Any schedule',
          description: 'Daily, hourly, or your own timing',
        },
        {
          icon: Repeat,
          title: 'Come back to results',
          description: 'Agents start the work for you',
        },
      ]}
      primaryAction={{ label: 'Create a schedule', onClick: handleSetUp }}
      secondaryAction={{ label: 'Not now', onClick: onClose }}
    />
  );
}
