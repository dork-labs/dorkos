/** Linked-instance managed account authentication start endpoint. */
import { ZodError } from 'zod';

import {
  ManagedAuthenticationFlowError,
  startManagedAuthentication,
} from '@/lib/connectors/managed/authentication-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Start one idempotent, owner-bound provider authentication flow. */
export async function POST(request: Request): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  try {
    return Response.json(
      await startManagedAuthentication({
        db: context.db,
        principal: context.principal,
        providerUserId: context.providerUserId,
        materialGeneration: context.materialGeneration,
        executionConfigDigest: context.executionConfigDigest,
        accounts: context.accounts,
        config: context.config,
        rawRequest: await request.json(),
        verifyLiveInstance: context.verifyLiveInstance,
        signal: request.signal,
      })
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (error instanceof ManagedAuthenticationFlowError) {
      const status =
        error.code === 'conflict'
          ? 409
          : error.code === 'not_found'
            ? 404
            : error.code === 'forbidden'
              ? 401
              : 503;
      return Response.json({ error: error.code, reason: error.message }, { status });
    }
    throw error;
  }
}
