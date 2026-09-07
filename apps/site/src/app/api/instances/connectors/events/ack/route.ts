/** Exact instance/key event handoff acknowledgement. */
import { ManagedConnectorEventAckRequestSchema } from '@dorkos/shared/connector-event-schemas';
import {
  resolveManagedConnectorPrincipal,
  managedContextFailure,
} from '@/lib/connectors/managed/request-context';
import { acknowledgeManagedConnectorEvents } from '@/lib/connectors/managed/event-delivery-service';
import { ManagedAuthorityUnauthorizedError } from '@/lib/connectors/managed/authority-service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Record durable local acceptance and erase hosted payload; this never asserts a destination ran. */
export async function POST(request: Request): Promise<Response> {
  const context = await resolveManagedConnectorPrincipal(request, 'events');
  if (context.status !== 'ok') return managedContextFailure(context);
  const parsed = ManagedConnectorEventAckRequestSchema.safeParse(
    await request.json().catch(() => null)
  );
  if (!parsed.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  try {
    return Response.json(
      await acknowledgeManagedConnectorEvents(context.db, context.principal, parsed.data.events)
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
