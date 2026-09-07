/** Hosted managed connector execution endpoint. */
import { ManagedConnectorExecutionRequestSchema } from '@dorkos/shared/connector-managed-schemas';
import { ZodError } from 'zod';

import {
  executeManagedConnectorOperation,
  findManagedExecutionReplay,
  ManagedExecutionConflictError,
  ManagedExecutionProviderUnavailableError,
  ManagedExecutionUnauthorizedError,
} from '@/lib/connectors/managed/execution-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
  resolveManagedConnectorPrincipal,
} from '@/lib/connectors/managed/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Execute one exact-account, exact-revision operation at most once. */
export async function POST(request: Request): Promise<Response> {
  const authenticated = await resolveManagedConnectorPrincipal(request, 'execute');
  if (authenticated.status !== 'ok') return managedContextFailure(authenticated);
  try {
    const rawRequest = ManagedConnectorExecutionRequestSchema.parse(await request.json());
    const replay = await findManagedExecutionReplay(
      authenticated.db,
      authenticated.principal,
      rawRequest
    );
    if (replay) return Response.json(replay);
    const context = await resolveManagedConnectorRequest(request, 'execute');
    if (context.status !== 'ok') return managedContextFailure(context);
    const response = await executeManagedConnectorOperation({
      db: context.db,
      principal: context.principal,
      rawRequest,
      accounts: context.accounts,
      operations: context.operations,
      verifyLiveInstance: context.verifyLiveInstance,
      signal: request.signal,
    });
    return Response.json(response);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (error instanceof ManagedExecutionConflictError) {
      return Response.json({ error: 'idempotency_conflict' }, { status: 409 });
    }
    if (error instanceof ManagedExecutionUnauthorizedError) {
      return Response.json({ error: 'authority_unavailable' }, { status: 403 });
    }
    if (error instanceof ManagedExecutionProviderUnavailableError) {
      return Response.json({ error: 'managed_connectors_unavailable' }, { status: 503 });
    }
    throw error;
  }
}
