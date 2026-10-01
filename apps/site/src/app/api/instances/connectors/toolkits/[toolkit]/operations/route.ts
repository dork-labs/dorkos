/** Exact managed operation schema discovery endpoint. */
import { ZodError } from 'zod';

import {
  ManagedRequestShapeError,
  listManagedOperationSchemas,
} from '@/lib/connectors/managed/discovery-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';
import { managedQueryInteger, strictManagedQuery } from '@/lib/connectors/managed/route-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Return and persist one exact-version immutable operation page. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ toolkit: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    const query = strictManagedQuery(request, ['version', 'toolkitVersion', 'cursor', 'limit']);
    return Response.json(
      await listManagedOperationSchemas({
        db: context.db,
        principal: context.principal,
        operations: context.operations,
        rawRequest: {
          version: query.version === '1' ? 1 : query.version,
          toolkit: (await params).toolkit,
          toolkitVersion: query.toolkitVersion,
          ...(query.cursor !== undefined && { cursor: query.cursor }),
          limit: managedQueryInteger(query.limit),
        },
        signal: request.signal,
      })
    );
  } catch (error) {
    if (
      error instanceof ManagedRequestShapeError ||
      (error instanceof Error && error.message === 'invalid_managed_query')
    ) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (error instanceof ZodError) {
      // Our own answer failed its wire schema: a mapping bug here, never the
      // caller's fault. Only the class and route are logged, never values.
      console.error(
        '[managed-discovery] internal wire-mapping failure',
        error.constructor.name,
        request.method,
        new URL(request.url).pathname
      );
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }
    return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
  }
}
