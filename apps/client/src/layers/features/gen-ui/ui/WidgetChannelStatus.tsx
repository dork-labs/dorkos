import { Button } from '@/layers/shared/ui';
import { useWidgetActions } from '../model/widget-context';
import type { WidgetChannelSubmission } from '../model/widget-channel';

/** Describe acceptance separately from runtime completion and claimed application handling. */
export function widgetChannelStatus(row: WidgetChannelSubmission, destination: string): string {
  if (row.phase === 'sending') return 'Saving…';
  if (row.phase !== 'accepted') return row.message ?? 'This action could not be saved.';
  const deliveries = row.receipt?.deliveries ?? [];
  if (!deliveries.length) return 'Saved to the document.';
  return deliveries
    .map((delivery) => {
      if (delivery.ackOutcome === 'handled' || delivery.status === 'handled')
        return `${destination} reported that it handled this action.`;
      if (delivery.ackOutcome === 'rejected' || delivery.status === 'rejected')
        return `${destination} could not handle this action.`;
      switch (delivery.status) {
        case 'turn_started':
          return `${destination} started working.`;
        case 'turn_done':
          return `${destination} finished. Handling is not confirmed yet.`;
        case 'in_doubt':
          return 'Saved; outcome unknown. Review before replaying.';
        case 'failed':
          return 'Saved; the agent request failed.';
        case 'expired':
          return 'Saved; expired before the agent started.';
        case 'superseded':
          return 'Saved; replaced by a newer change.';
        case 'cancelled':
          return 'Saved; the agent request was cancelled.';
        case 'unavailable':
          return 'Saved; the destination is not available.';
        default:
          return `Saved; waiting for ${destination}.`;
      }
    })
    .join(' ');
}
/** Per-click durable status, with an exact-envelope retry for uncertain acceptance only. */
export function WidgetChannelStatus({
  controlId,
  descendants = false,
}: {
  controlId: string;
  descendants?: boolean;
}) {
  const { channel, channelRecords, retryChannel } = useWidgetActions();
  if (!channel) return null;
  const rows = channelRecords.filter(
    (row) =>
      row.controlId === controlId || (descendants && row.controlId.startsWith(`${controlId}.`))
  );
  if (!rows.length) return null;
  return (
    <ul
      className="text-muted-foreground mt-2 flex max-h-32 flex-col gap-1.5 overflow-y-auto text-xs"
      aria-live="polite"
      aria-relevant="additions text"
      data-testid="widget-action-statuses"
    >
      {rows.map((row, index) => (
        <li
          key={row.event.id}
          data-testid="widget-action-status"
          data-event-id={row.event.id}
          className="flex flex-wrap items-center gap-2"
        >
          <span>
            {rows.length > 1 ? `Action ${index + 1}: ` : ''}
            {widgetChannelStatus(row, channel.destinationLabel)}
          </span>
          {row.phase === 'retry' && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void retryChannel(row.event.id)}
              data-testid="widget-action-retry"
            >
              Try again
            </Button>
          )}
        </li>
      ))}
    </ul>
  );
}
