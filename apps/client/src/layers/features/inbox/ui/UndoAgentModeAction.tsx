/**
 * Undo on the notice DorkOS posts when one of our agents changed a running
 * schedule without asking (DOR-3703): puts back exactly what that notice
 * named, its mode or its prompt.
 *
 * @module features/inbox/ui/UndoAgentModeAction
 */
import { useEffect, useRef } from 'react';
import { useUndoAgentTaskMode } from '@/layers/entities/tasks';
import { appRoutes } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui/button';

/** The notice action that asks for this button (`schedule.armed_by_agent`). */
export const UNDO_AGENT_MODE_ACTION_ID = 'undo-mode';

/** Props for {@link UndoAgentModeAction}. */
export interface UndoAgentModeActionProps {
  /** The schedule the agent changed: the notice's subject. */
  taskId: string;
  /** The notice itself, so the Undo acts only on the change it named. */
  notificationId: string;
}

/** The server's sentence for a refused Undo, or its headline when it sent none. */
function refusalOf(error: Error | null): string {
  const said = (error as (Error & { body?: { message?: unknown } }) | null)?.body?.message;
  return typeof said === 'string' ? said : (error?.message ?? 'Not undone.');
}

/**
 * "Undo": a compact button beside the notice that puts back what it named, and
 * says when it worked. Refused (the task changed since), the button goes and
 * the reason takes the notice's full width, ending in a link to open the task;
 * it is announced, and focus moves to the link.
 *
 * Returns sibling elements, laid out by the notice's own wrapping row.
 *
 * @param props - The schedule and the notice.
 */
export function UndoAgentModeAction({ taskId, notificationId }: UndoAgentModeActionProps) {
  const undo = useUndoAgentTaskMode();
  const navigate = useSafeNavigate();
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (undo.isError) open.current?.focus();
  }, [undo.isError]);

  if (undo.isError) {
    return (
      <p
        role="status"
        data-slot="inbox-row-undo-refused"
        // Under the notice's text column: past its dot, its glyph and their gaps.
        className="text-muted-foreground basis-full pr-2 pb-1 pl-[calc(0.5rem+0.375rem+0.625rem+18px+0.625rem)] text-xs break-words"
      >
        {refusalOf(undo.error)}{' '}
        <button
          ref={open}
          type="button"
          className="text-foreground underline"
          onClick={() => {
            if (navigate !== null) void navigate(appRoutes.tasks());
          }}
        >
          Open it to check.
        </button>
      </p>
    );
  }
  // Done: plain text, not a button that no longer does anything.
  if (undo.isSuccess) {
    return (
      <span
        data-slot="inbox-row-undone"
        className="text-muted-foreground shrink-0 self-start px-2 py-1 text-xs sm:self-center"
      >
        Undone
      </span>
    );
  }
  return (
    <Button
      type="button"
      variant="outline"
      size="xs"
      data-slot="inbox-row-undo-mode"
      // A 44px target on a phone, compact beside the notice; its own size from `sm`.
      className="h-11 min-w-11 shrink-0 self-start sm:h-auto sm:min-w-0 sm:self-center"
      disabled={undo.isPending}
      onClick={() => undo.mutate({ taskId, notificationId })}
    >
      Undo
    </Button>
  );
}
