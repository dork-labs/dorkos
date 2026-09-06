import { Plus } from 'lucide-react';
import { Button } from '@/layers/shared/ui/button';
import { useIsMobile } from '@/layers/shared/model';
import { cn } from '@/layers/shared/lib';
import { useTasksEnabled, useTaskTemplateDialog } from '@/layers/entities/tasks';

/**
 * The Schedules page action: make a new one.
 *
 * Says "Schedule", not "Task", and so does every dialog it opens (DOR-1490).
 * The product now calls these **scheduled tasks** in full and **schedules**
 * where a label has no room, because the bare word "task" collides with the
 * to-do list a chat turn keeps. Only the words moved: the route is still
 * `/tasks` and the component names still say Task.
 *
 * **On a phone it is a `+`, exactly as `/team`'s New agent is** (DOR-1747). The
 * home bar carries four tab labels — Home, Activity, Scheduled, Workspaces —
 * and the strip holding them stops shrinking at its `min-w-28` floor, so the
 * words on this button were the last thing in the row still spending width that
 * the row did not have. Measured at 390px: the actions cluster is `shrink-0`,
 * so it did not yield either, and it painted 11px past the bar's own wrapper —
 * over the health dot and into the fixed cluster, with the tab strip clipped at
 * both ends behind it. `+` beside a list of schedules is not ambiguous, and the
 * label stays on the button as its accessible name, so it is named the same at
 * both widths.
 *
 * Squared to 35px there rather than left at `size="xs"`'s 24px, for the reason
 * `/team` squares its own: this is the bar's only write action, and it must not
 * become a shorter target than the tabs beside it (35px — the 36px row less its
 * hairline) the moment it loses its label.
 *
 * Draws nothing when tasks are switched off, because a button that opens a
 * dialog for a disabled feature is a promise the cockpit cannot keep.
 */
export function NewTaskAction() {
  const tasksEnabled = useTasksEnabled();
  const openBlank = useTaskTemplateDialog((s) => s.openBlank);
  const isMobile = useIsMobile();

  if (!tasksEnabled) return null;

  return (
    <Button
      variant="outline"
      size="xs"
      onClick={openBlank}
      aria-label={isMobile ? 'New Schedule' : undefined}
      className={cn(isMobile && 'h-[35px] w-[35px] p-0')}
    >
      <Plus />
      {!isMobile && 'New Schedule'}
    </Button>
  );
}
