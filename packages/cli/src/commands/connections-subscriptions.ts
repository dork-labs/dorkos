/** Read-only notification visibility through the running server's program authority. */
import { ConnectorAgentEventSubscriptionPageSchema } from '@dorkos/shared/connector-event-schemas';
import { apiCall } from '../lib/api-client.js';
import { printJson, renderTable } from '../lib/operator-output.js';

/** Show exactly one requested agent's receive grants, without opening owner management routes. */
export async function runConnectionSubscriptions(args: {
  agentId: string;
  json: boolean;
  cursor?: string;
  limit?: number;
}): Promise<number> {
  const query = new URLSearchParams({ agentId: args.agentId });
  if (args.cursor) query.set('cursor', args.cursor);
  if (args.limit !== undefined) query.set('limit', String(args.limit));
  const page = ConnectorAgentEventSubscriptionPageSchema.parse(
    await apiCall('GET', `/api/connectors/accessible/subscriptions?${query}`)
  );
  if (page.agentId !== args.agentId) throw new Error('The response belongs to a different agent.');
  if (args.json) printJson(page);
  else if (page.subscriptions.length === 0)
    console.log('This agent has no approved notifications.');
  else {
    const printable = (value: string) => value.replace(/\p{Cc}/gu, ' ');
    console.log(
      renderTable(
        ['CONNECTION', 'SERVICE', 'LABEL', 'EVENT', 'DESTINATION', 'STATE', 'TIMING'],
        page.subscriptions.map((subscription) =>
          [
            subscription.connectionId,
            subscription.toolkit,
            subscription.label,
            subscription.displayName,
            `${subscription.destination.kind}:${subscription.destination.id}`,
            subscription.state === 'active' ? 'Available' : 'Unavailable',
            subscription.deliveryMode === 'webhook'
              ? 'Push'
              : subscription.deliveryMode === 'polling'
                ? subscription.expectedCadenceSeconds
                  ? `Every ${subscription.expectedCadenceSeconds}s`
                  : 'Checks periodically'
                : 'Timing unknown',
          ].map(printable)
        )
      )
    );
    if (page.nextCursor) console.log(`\nNext cursor: ${page.nextCursor}`);
  }
  return 0;
}
