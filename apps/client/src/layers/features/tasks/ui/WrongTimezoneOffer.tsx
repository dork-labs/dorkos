import type { Task } from '@dorkos/shared/types';
import { useUpdateTask } from '@/layers/entities/tasks';
import { TOUCH_TARGET_MIN_H } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { wrongTimezoneOffer } from '../lib/task-time';
import { useWrongTimezoneDismissals } from '../model/wrong-timezone-dismissals';

interface WrongTimezoneOfferProps {
  task: Task;
  viewerTimezone: string;
}

/** Each answer is a 44px target under a thumb, and a line of text past md. */
const ANSWER = cn(
  TOUCH_TARGET_MIN_H,
  'focus-ring inline-flex items-center rounded-sm whitespace-nowrap md:min-h-6'
);

/** Offer to keep a fixed cron time while moving a suspicious schedule to the viewer's zone. */
export function WrongTimezoneOffer({ task, viewerTimezone }: WrongTimezoneOfferProps) {
  const updateTask = useUpdateTask();
  const dismissed = useWrongTimezoneDismissals((state) => state.dismissed[task.id] === true);
  const dismiss = useWrongTimezoneDismissals((state) => state.dismiss);
  const offer = wrongTimezoneOffer(task, viewerTimezone);
  if (!offer || dismissed) return null;

  return (
    <div
      data-slot="wrong-timezone-offer"
      className="bg-muted/40 mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 rounded-md px-2 py-1 text-xs"
    >
      <strong className="text-status-warning-fg font-medium">
        Set in {offer.scheduleZone}, so it runs at {offer.viewerTime} for you.
      </strong>
      {/* The two answers wrap together, so neither is left alone on a line. */}
      <span className="inline-flex flex-wrap items-center gap-x-3 sm:gap-x-1.5">
        <button
          type="button"
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            ANSWER,
            'text-status-warning-fg font-medium hover:underline focus-visible:underline'
          )}
          onClick={(event) => {
            // The row toggles open on click; these buttons act on their own.
            event.stopPropagation();
            updateTask.mutate({ id: task.id, timezone: viewerTimezone });
          }}
        >
          Use my time zone
        </button>
        <span className="text-muted-foreground hidden sm:inline" aria-hidden="true">
          ·
        </span>
        <button
          type="button"
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            ANSWER,
            'text-muted-foreground hover:text-foreground focus-visible:text-foreground hover:underline focus-visible:underline'
          )}
          onClick={(event) => {
            event.stopPropagation();
            dismiss(task.id);
          }}
        >
          Keep it as set
        </button>
      </span>
    </div>
  );
}
