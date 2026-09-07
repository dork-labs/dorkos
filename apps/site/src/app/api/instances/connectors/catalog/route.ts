/** Account-free managed toolkit catalog endpoint. */
import { ZodError } from 'zod';

import { listManagedConnectorCatalog } from '@/lib/connectors/managed/discovery-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';
import { managedQueryInteger, strictManagedQuery } from '@/lib/connectors/managed/route-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Return one bounded account-free toolkit page to a linked instance. */
export async function GET(request: Request): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    const query = strictManagedQuery(request, ['version', 'query', 'cursor', 'limit']);
    return Response.json(
      await listManagedConnectorCatalog({
        operations: context.operations,
        config: context.config,
        rawRequest: {
          version: query.version === '1' ? 1 : query.version,
          ...(query.query !== undefined && { query: query.query }),
          ...(query.cursor !== undefined && { cursor: query.cursor }),
          limit: managedQueryInteger(query.limit),
        },
        signal: request.signal,
      })
    );
  } catch (error) {
    if (
      error instanceof ZodError ||
      (error instanceof Error && error.message === 'invalid_managed_query')
    ) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
  }
}
