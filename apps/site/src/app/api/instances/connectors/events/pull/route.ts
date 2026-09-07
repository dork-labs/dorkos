/** Authenticated managed event pull; provider downtime does not prevent buffered recovery. */
import { ManagedConnectorEventPullRequestSchema } from '@dorkos/shared/connector-event-schemas';
import {
  resolveManagedConnectorPrincipal,
  managedContextFailure,
} from '@/lib/connectors/managed/request-context';
import { managedEventProtector } from '@/lib/connectors/managed/event-protection';
import {
  pullManagedConnectorEvents,
  sweepManagedConnectorEventRetention,
} from '@/lib/connectors/managed/event-delivery-service';
import { ManagedAuthorityUnauthorizedError } from '@/lib/connectors/managed/authority-service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Lease only events addressed to the verified linked instance and current receive scope. */
export async function POST(request: Request): Promise<Response> {
  const context = await resolveManagedConnectorPrincipal(request, 'events');
  if (context.status !== 'ok') return managedContextFailure(context);
  const parsed = ManagedConnectorEventPullRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const protector = managedEventProtector();
  if (!protector) return Response.json({ error: 'events_unavailable' }, { status: 503 });
  try {
    await sweepManagedConnectorEventRetention(context.db);
    return Response.json(
      await pullManagedConnectorEvents(context.db, context.principal, protector, parsed.data.limit)
    );
  } catch (error) {
    return Response.json(
      {
        error:
          error instanceof ManagedAuthorityUnauthorizedError
            ? 'unauthorized'
            : 'events_unavailable',
      },
      { status: error instanceof ManagedAuthorityUnauthorizedError ? 401 : 503 }
    );
  }
}
