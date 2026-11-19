import type { ModelSubstitutedPart } from '@dorkos/shared/types';
import { Bot } from 'lucide-react';
import { CompactResultRow } from '@/layers/shared/ui';

/** Props for {@link ModelSubstitutedRow}. */
interface ModelSubstitutedRowProps {
  /** Display name of the model the session named. */
  fromName: string;
  /** Display name of the model the turn ran on. */
  toName: string;
  /** Omitted by older callers whose records described credits coverage. */
  reason?: ModelSubstitutedPart['reason'];
}

/**
 * A lasting note in the conversation that a turn ran on another model than the
 * session named: account availability (DOR-3168) or credits coverage (DOR-2636).
 *
 * Calm, like the compaction row beside it: nothing went wrong, a choice was
 * made, and the person is told what it was and where to change it. Sourced
 * from the `model_substituted` part, live and on a reopened conversation.
 */
export function ModelSubstitutedRow({
  fromName,
  toName,
  reason = 'credits-not-covered',
}: ModelSubstitutedRowProps) {
  return (
    <CompactResultRow
      data-testid="model-substituted-row"
      icon={<Bot aria-hidden="true" className="text-muted-foreground size-3 shrink-0" />}
      label={
        <span className="text-muted-foreground">
          {reason === 'account-not-available' ? (
            <>
              Using {toName}. {fromName} isn’t available on this account.
            </>
          ) : (
            <>
              DorkOS credits don’t cover {fromName}, so this ran on {toName}. Switch in the model
              menu.
            </>
          )}
        </span>
      }
    />
  );
}
