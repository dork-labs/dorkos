import { Button, SettingRow } from '@/layers/shared/ui';
import { useAutonomyAcknowledgement } from '@/layers/entities/config';

/**
 * The date, in the reader's own locale. A stored ISO string that somehow is not
 * a date falls back to the raw value rather than "Invalid Date" — the row's job
 * is to show what is on file, and it can do that even when it cannot format it.
 */
function formatAcknowledgedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/**
 * The standing Full-autonomy acknowledgement, in Settings (spec `trust-dial`,
 * decision 5).
 *
 * One row, and only when there is something to say. Ticking "don't show this
 * again" in the autonomy dialog is a choice a person makes once, in a hurry, in
 * a modal they were trying to get past — so it has to be findable afterwards, or
 * it is a setting with no way back. Nothing to show before then: a row reading
 * "not acknowledged" would advertise a switch nobody has touched and invite
 * people to go looking for the dialog they have not seen yet.
 *
 * Reset clears the record. It does not change any running session's permission
 * mode, and does not claim to — what comes back is the asking.
 */
export function AutonomyAcknowledgementRow() {
  const { acknowledgedAt, clear, isPending } = useAutonomyAcknowledgement();

  if (!acknowledgedAt) return null;

  return (
    <SettingRow
      label="Full autonomy"
      description={`You acknowledged what this means on ${formatAcknowledgedAt(acknowledgedAt)}, and asked not to be shown it again.`}
    >
      <Button
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={clear}
        data-testid="autonomy-ack-reset"
      >
        Reset
      </Button>
    </SettingRow>
  );
}
