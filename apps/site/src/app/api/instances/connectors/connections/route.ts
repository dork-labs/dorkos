/** Managed connection inventory endpoint. */
import { ZodError } from 'zod';

import { listManagedConnections } from '@/lib/connectors/managed/discovery-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';
import { managedQueryInteger, strictManagedQuery } from '@/lib/connectors/managed/route-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Return one bounded connection page owned by the linked instance. */
export async function GET(request: Request): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    const query = strictManagedQuery(request, ['version', 'toolkit', 'cursor', 'limit']);
    return Response.json(
      await listManagedConnections(context.db, context.principal, {
        version: query.version === '1' ? 1 : query.version,
        ...(query.toolkit !== undefined && { toolkit: query.toolkit }),
        ...(query.cursor !== undefined && { cursor: query.cursor }),
        limit: managedQueryInteger(query.limit),
      })
    );
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
