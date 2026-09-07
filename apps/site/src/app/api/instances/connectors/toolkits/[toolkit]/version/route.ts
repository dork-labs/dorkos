/** Exact managed toolkit version endpoint. */
import { ZodError } from 'zod';

import { resolveManagedToolkitVersion } from '@/lib/connectors/managed/discovery-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';
import { strictManagedQuery } from '@/lib/connectors/managed/route-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Resolve one trusted concrete toolkit version. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ toolkit: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    const query = strictManagedQuery(request, ['version']);
    return Response.json(
      await resolveManagedToolkitVersion({
        operations: context.operations,
        rawRequest: {
          version: query.version === '1' ? 1 : query.version,
          toolkit: (await params).toolkit,
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
