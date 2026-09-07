/** Hosted managed connector authority command endpoint. */
import { ZodError } from 'zod';

import {
  applyManagedAuthorityCommand,
  ManagedAuthorityProviderUnavailableError,
  ManagedAuthorityUnauthorizedError,
} from '@/lib/connectors/managed/authority-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Apply one exact idempotent local-to-hosted authority command. */
export async function POST(request: Request): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  let body: unknown;
  try {
    body = await request.json();
    const result = await applyManagedAuthorityCommand(context.db, context.principal, body, {
      accounts: context.accounts,
      providerUserId: context.providerUserId,
      materialGeneration: context.materialGeneration,
      executionConfigDigest: context.executionConfigDigest,
      signal: request.signal,
    });
    if (result.conflict) {
      return Response.json({ error: 'idempotency_conflict' }, { status: 409 });
    }
    return Response.json(result.status);
  } catch (error) {
    if (error instanceof ZodError) {
      return Response.json({ error: 'invalid_request' }, { status: 400 });
    }
    if (error instanceof ManagedAuthorityUnauthorizedError) {
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
    if (error instanceof ManagedAuthorityProviderUnavailableError) {
      return Response.json({ error: 'provider_unavailable' }, { status: 503 });
    }
    throw error;
  }
}
