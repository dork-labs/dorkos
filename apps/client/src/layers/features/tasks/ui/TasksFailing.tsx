/**
 * The Schedules list's honest count (DOR-3123, spec `schedules-failing` §2):
 * the Failing chip in the filter bar, the "2 failing" beside the result count,
 * and what the list says when the Failing filter leaves nothing.
 *
 * @module features/tasks/ui/TasksFailing
 */
import { motion } from 'motion/react';
import { CircleCheck } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { cn } from '@/layers/shared/lib';

/**
 * Invisible reach that grows the 28px pill to a 44px touch target below `md`,
 * the same reach the filter bar's own pills use.
 */
const TOUCH_REACH = 'relative after:absolute after:-inset-x-1 after:-inset-y-2 md:after:hidden';

/**
 * The Failing chip: `Failing 2`. A toggle, so it says whether it is on.
 *
 * @param count - How many schedules are failing.
 * @param active - Whether the Failing filter is on.
 * @param onToggle - Turn the filter on or off.
 */
export function FailingChip({
  count,
  active,
  onToggle,
}: {
  count: number;
  active: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      data-slot="tasks-failing-chip"
      aria-pressed={active}
      onClick={onToggle}
      className={cn(
        'text-destructive hover:bg-destructive/10 inline-flex h-7 items-center gap-1.5 rounded-md border px-2.5 text-xs',
        TOUCH_REACH,
        active ? 'border-destructive/50 bg-destructive/10' : 'border-input'
      )}
    >
      Failing
      <span className="font-medium tabular-nums">{count}</span>
    </button>
  );
}

/**
 * "· 2 failing" after the result count, which applies the Failing filter.
 * Drawn only when something is failing: zero says nothing more.
 *
 * @param count - How many schedules are failing; at least 1.
 * @param onShow - Apply the Failing filter.
 */
export function FailingCount({ count, onShow }: { count: number; onShow: () => void }) {
  return (
    <>
      <span aria-hidden>&middot;</span>
      <button
        type="button"
        data-slot="tasks-failing-count"
        onClick={onShow}
        className="text-destructive rounded-sm underline-offset-2 hover:underline"
      >
        {count} failing
      </button>
    </>
  );
}

/**
 * What the list says when the Failing filter is on and nothing is failing.
 *
 * @param onShowAll - Turn the Failing filter off.
 */
export function NothingFailing({ onShowAll }: { onShowAll: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 20 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: 'easeOut' }}
      data-slot="tasks-nothing-failing"
      className="flex flex-col items-center justify-center gap-3 py-12 text-center"
    >
      <CircleCheck className="text-muted-foreground/50 size-10" aria-hidden />
      <p className="text-muted-foreground text-sm">
        Nothing is failing. Every schedule’s last run did its job.
      </p>
      <Button variant="outline" size="sm" onClick={onShowAll}>
        Show all
      </Button>
    </motion.div>
  );
}
