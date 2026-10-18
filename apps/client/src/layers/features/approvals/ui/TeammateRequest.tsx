import type { PendingApproval } from '@dorkos/shared/approval-schemas';

/** The tools that run as the owner on this computer, with nothing to stop them. */
const RUNS_AS_YOU = new Set(['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'WebFetch']);

/** The line those tools carry, so a person reads what an Allow hands over. */
export const RUNS_AS_YOU_LINE = 'Runs as you, with full access to this computer.';

export interface TeammateRequestProps {
  /** Who asked, by the name the space shows. Their own words, drawn as text. */
  teammate: NonNullable<PendingApproval['teammate']>;
  /** Where the result of the call will be posted. */
  resultGoesTo: NonNullable<PendingApproval['resultGoesTo']>;
  /** Why they say they need it, in their words, when they gave a reason. */
  reason?: string;
}

/**
 * The lines a teammate's request carries (DOR-2956): which space member asked, in their own
 * quoted words, what a shell, write or fetch can reach, and where the result will be posted,
 * since everyone in that room can read it.
 * Every value is drawn as plain text: a name or reason is the teammate's, never the card's.
 */
export function TeammateRequest({ teammate, resultGoesTo, reason }: TeammateRequestProps) {
  return (
    <div data-slot="approval-teammate" className="mt-0.5 flex flex-col gap-0.5 text-xs">
      <p className="text-foreground break-words">
        {teammate.displayName} in {resultGoesTo.space} asked for this.
        {reason && (
          <>
            {' '}
            They say: <q className="text-muted-foreground break-words">{reason}</q>
          </>
        )}
      </p>
      {teammate.tool && RUNS_AS_YOU.has(teammate.tool) && (
        <p data-slot="approval-runs-as-you" className="text-foreground font-medium">
          {RUNS_AS_YOU_LINE}
        </p>
      )}
      <p data-slot="approval-result-goes-to" className="text-muted-foreground break-words">
        The result will be posted in #{resultGoesTo.room} in {resultGoesTo.space}, where everyone
        there can read it.
      </p>
    </div>
  );
}
