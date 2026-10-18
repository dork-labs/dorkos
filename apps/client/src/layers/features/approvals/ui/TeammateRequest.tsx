import type { PendingApproval } from '@dorkos/shared/approval-schemas';

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
 * quoted words, and where the result will be posted, since everyone in that room can read it.
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
      <p data-slot="approval-result-goes-to" className="text-muted-foreground break-words">
        The result will be posted in #{resultGoesTo.room} in {resultGoesTo.space}, where everyone
        there can read it.
      </p>
    </div>
  );
}
