/** Hosted managed connector receipt endpoint. */
import { z } from 'zod';

import { getManagedExecutionReceipt } from '@/lib/connectors/managed/execution-service';
import {
  managedContextFailure,
  resolveManagedConnectorPrincipal,
} from '@/lib/connectors/managed/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const AttemptIdSchema = z.string().min(1).max(200);

/** Read one authoritative hosted receipt without arguments or result data. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ attemptId: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorPrincipal(request, 'usage');
  if (context.status !== 'ok') return managedContextFailure(context);
  const attemptId = AttemptIdSchema.safeParse((await params).attemptId);
  if (!attemptId.success) return Response.json({ error: 'not_found' }, { status: 404 });
  const result = await getManagedExecutionReceipt(context.db, context.principal, attemptId.data);
  return result ? Response.json(result) : Response.json({ error: 'not_found' }, { status: 404 });
}
