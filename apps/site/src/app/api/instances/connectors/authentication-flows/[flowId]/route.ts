/** Linked-instance managed account authentication status endpoint. */
import { z } from 'zod';

import {
  getManagedAuthenticationState,
  reconcileManagedAuthentication,
} from '@/lib/connectors/managed/authentication-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const FlowIdSchema = z.string().uuid();

/** Read one flow owned by the verified linked instance. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ flowId: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  const flowId = FlowIdSchema.safeParse((await params).flowId);
  if (!flowId.success) return Response.json({ error: 'not_found' }, { status: 404 });
  await reconcileManagedAuthentication({
    db: context.db,
    principal: context.principal,
    providerUserId: context.providerUserId,
    materialGeneration: context.materialGeneration,
    executionConfigDigest: context.executionConfigDigest,
    accounts: context.accounts,
    flowId: flowId.data,
    signal: request.signal,
  });
  const state = await getManagedAuthenticationState({
    db: context.db,
    principal: context.principal,
    flowId: flowId.data,
    callbackOrigin: context.config.callbackOrigin,
    projectApiKey: context.config.projectApiKey,
  });
  return state ? Response.json(state) : Response.json({ error: 'not_found' }, { status: 404 });
}
