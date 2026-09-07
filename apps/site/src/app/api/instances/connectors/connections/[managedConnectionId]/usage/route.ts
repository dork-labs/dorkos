/** Exact-connection hosted managed usage endpoint. */
import { ZodError, z } from 'zod';

import {
  listManagedConnectorUsage,
  ManagedUsageCursorError,
  ManagedUsageNotFoundError,
} from '@/lib/connectors/managed/usage-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';
import { managedQueryInteger, strictManagedQuery } from '@/lib/connectors/managed/route-query';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ManagedConnectionIdSchema = z.string().min(1).max(200);

/** Return one exact owned connection's authoritative hosted usage. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ managedConnectionId: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'usage');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    const query = strictManagedQuery(request, ['version', 'agentId', 'cursor', 'limit']);
    return Response.json(
      await listManagedConnectorUsage({
        db: context.db,
        principal: context.principal,
        cursorSecret: context.config.projectApiKey!,
        rawRequest: {
          version: query.version === '1' ? 1 : query.version,
          managedConnectionId: ManagedConnectionIdSchema.parse((await params).managedConnectionId),
          ...(query.agentId && { agentId: query.agentId }),
          ...(query.cursor && { cursor: query.cursor }),
          ...(query.limit !== undefined && { limit: managedQueryInteger(query.limit) }),
        },
      })
    );
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof ManagedUsageCursorError ||
      (error instanceof Error && error.message === 'invalid_managed_query')
    ) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (error instanceof ManagedUsageNotFoundError) {
      return Response.json({ error: 'not_found' }, { status: 404 });
    }
    return Response.json(
      { version: 1, status: 'unavailable', reason: 'Managed usage is temporarily unavailable.' },
      { status: 503 }
    );
  }
}
