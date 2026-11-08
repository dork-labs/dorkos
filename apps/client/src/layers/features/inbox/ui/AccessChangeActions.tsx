/**
 * Undo and Keep the change on the Needs-you item DorkOS posts when one agent
 * takes another agent's access to a connected app away (spec
 * `agent-grant-autonomy`, Security G2), with the agent's reason under it.
 *
 * The reason is the agent's own words. It is read from the person's own route,
 * never from the notification, and drawn as plain text with the agent's name
 * on it, so it never reads as DorkOS's words. React escapes it: a link or a tag
 * in it shows as the characters the agent typed.
 *
 * @module features/inbox/ui/AccessChangeActions
 */
import { useEffect, useRef, useState } from 'react';
import { useAccessChange, useUndoAccessChange } from '@/layers/entities/connectors';
import { useRegisteredAgents } from '@/layers/entities/mesh';
import { useMarkRead } from '@/layers/entities/notifications';
import { appRoutes } from '@/layers/shared/lib';
import { useSafeNavigate } from '@/layers/shared/model';
import { Button } from '@/layers/shared/ui/button';

/** The notice actions that ask for these buttons (`connector.access_narrowed`). */
export const UNDO_ACCESS_CHANGE_ACTION_ID = 'undo-access-change';

/** Props for {@link AccessChangeActions}. */
export interface AccessChangeActionsProps {
  /** The change: the notice's subject. */
  changeId: string;
  /** The notice itself, which Keep the change marks read. */
  notificationId: string;
}

/** Under the notice's text column: past its dot, its glyph and their gaps. */
const UNDER_TEXT =
  'basis-full pr-2 pb-1 pl-[calc(0.5rem+0.375rem+0.625rem+18px+0.625rem)] text-xs break-words';

/** The server's sentence for a refused Undo, or a plain one when it sent none. */
function refusalOf(error: Error | null): string {
  return error?.message || 'Not given back.';
}

/** What to call the agent that made the change: its name, or "The agent". */
function useAgentName(agentId: string | undefined): string {
  const { data } = useRegisteredAgents();
  const agent = data?.agents.find((candidate) => candidate.id === agentId);
  return agent ? (agent.displayName ?? agent.name) : 'The agent';
}

/**
 * The agent's reason, then Undo and Keep the change. Undo's result shows in
 * place ("Access given back"), never as a toast. Refused (access changed since),
 * the buttons go and the reason it was refused takes the row, ending in a link
 * to the Connections page.
 *
 * Returns sibling elements, laid out by the notice's own wrapping row.
 *
 * @param props - The change and the notice.
 */
export function AccessChangeActions({ changeId, notificationId }: AccessChangeActionsProps) {
  const change = useAccessChange(changeId);
  const undo = useUndoAccessChange();
  const keep = useMarkRead();
  // Keeping is marking the item read, which is optimistic: it shows at once.
  const [kept, setKept] = useState(false);
  const navigate = useSafeNavigate();
  const actorName = useAgentName(change.data?.actorId);
  const open = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (undo.isError) open.current?.focus();
  }, [undo.isError]);

  const reason = change.isPending ? (
    // Holds the line's height while the reason loads, so the row never jumps.
    <span
      aria-hidden
      data-slot="access-change-reason-loading"
      className={`${UNDER_TEXT} text-muted-foreground block h-4`}
    />
  ) : change.data?.reason ? (
    <p data-slot="access-change-reason" className={`${UNDER_TEXT} text-muted-foreground`}>
      {`${actorName}’s reason: ${change.data.reason}`}
    </p>
  ) : null;

  if (undo.isError) {
    return (
      <>
        {reason}
        <p
          role="status"
          data-slot="access-change-undo-refused"
          className={`${UNDER_TEXT} text-muted-foreground`}
        >
          {refusalOf(undo.error)}{' '}
          <button
            ref={open}
            type="button"
            className="text-foreground underline"
            onClick={() => {
              if (navigate !== null) void navigate({ ...appRoutes.connections(), search: {} });
            }}
          >
            Open Connections.
          </button>
        </p>
      </>
    );
  }
  if (undo.isSuccess || kept) {
    return (
      <>
        {reason}
        <span
          role="status"
          data-slot="access-change-settled"
          className="text-muted-foreground shrink-0 self-start px-2 py-1 text-xs sm:self-center"
        >
          {undo.isSuccess ? 'Access given back' : 'Kept'}
        </span>
      </>
    );
  }
  return (
    <>
      {reason}
      <Button
        type="button"
        variant="outline"
        size="xs"
        data-slot="access-change-undo"
        // A 44px target on a phone, compact beside the notice; its own size from `sm`.
        className="h-11 min-w-11 shrink-0 self-start sm:h-auto sm:min-w-0 sm:self-center"
        disabled={undo.isPending || keep.isPending}
        onClick={() => undo.mutate(changeId)}
      >
        Undo
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="xs"
        data-slot="access-change-keep"
        className="h-11 shrink-0 self-start sm:h-auto sm:self-center"
        disabled={undo.isPending || keep.isPending}
        onClick={() => {
          keep.mutate(notificationId);
          setKept(true);
        }}
      >
        Keep the change
      </Button>
    </>
  );
}
