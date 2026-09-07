/** Exact managed connection lookup endpoint. */
import { z, ZodError } from 'zod';

import { getManagedConnection } from '@/lib/connectors/managed/discovery-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';
import { strictManagedQuery } from '@/lib/connectors/managed/route-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ManagedConnectionIdSchema = z.string().min(1).max(200);

/** Return one exact connection owned by the linked instance. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ managedConnectionId: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    const query = strictManagedQuery(request, ['version']);
    if (query.version !== '1') throw new Error('invalid_managed_query');
    const id = ManagedConnectionIdSchema.parse((await params).managedConnectionId);
    const result = await getManagedConnection(context.db, context.principal, id);
    return result ? Response.json(result) : Response.json({ error: 'not_found' }, { status: 404 });
  } catch (error) {
    if (
      error instanceof ZodError ||
      (error instanceof Error && error.message === 'invalid_managed_query')
    ) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    throw error;
  }
}
