/**
 * One commitment in a list: what was promised, to whom, when it is due, and
 * (while open, for someone who may change it) the two things a person does
 * with it.
 *
 * @module features/commitments/ui/CommitmentRow
 */
import type { Commitment } from '@dorkos/shared/commitment-schemas';
import { Button } from '@/layers/shared/ui';
import { cn } from '@/layers/shared/lib';
import { CLOSED_STATE_LABEL, dueLabel, toLabel } from '../lib/commitment-labels';

/** Props for {@link CommitmentRow}. */
export interface CommitmentRowProps {
  commitment: Commitment;
  /** The agent's name, drawn first when the list spans agents. */
  agentName?: string | null;
  /** Looks up a roster name for the recipient. */
  nameOf?: (id: string) => string | null | undefined;
  /** Mark it kept or dropped. Omitted for a closed commitment, or a read-only list. */
  onClose?: (state: 'kept' | 'dropped') => void;
  /** True while a change to this row is being saved. */
  busy?: boolean;
}

/** One commitment, open or closed. */
export function CommitmentRow({
  commitment,
  agentName,
  nameOf,
  onClose,
  busy,
}: CommitmentRowProps) {
  const open = commitment.state === 'open';
  const who = [agentName, toLabel(commitment.to, nameOf)].filter(Boolean).join(' · ');
  const due = open ? dueLabel(commitment.dueAt) : null;

  return (
    <li
      data-slot="commitment-row"
      data-state={commitment.state}
      data-overdue={commitment.overdue || undefined}
      className="flex flex-col gap-2 rounded-md px-2 py-2 sm:flex-row sm:items-center sm:gap-3"
    >
      <div className="min-w-0 flex-1">
        <p
          className={cn(
            'text-sm break-words',
            !open && 'text-muted-foreground',
            commitment.state === 'dropped' && 'line-through'
          )}
        >
          {commitment.what}
        </p>
        {(who || due || !open) && (
          <div className="text-muted-foreground mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            {commitment.state !== 'open' && <span>{CLOSED_STATE_LABEL[commitment.state]}</span>}
            {who && <span className="min-w-0 truncate">{who}</span>}
            {due && (
              <span className={cn(commitment.overdue && 'text-destructive font-medium')}>
                {due}
              </span>
            )}
          </div>
        )}
      </div>
      {open && onClose && (
        <div className="flex shrink-0 gap-1">
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            onClick={() => onClose('kept')}
            aria-label={`Mark kept: ${commitment.what}`}
          >
            Mark kept
          </Button>
          <Button
            size="xs"
            variant="ghost"
            disabled={busy}
            onClick={() => onClose('dropped')}
            aria-label={`Drop: ${commitment.what}`}
          >
            Drop
          </Button>
        </div>
      )}
    </li>
  );
}
