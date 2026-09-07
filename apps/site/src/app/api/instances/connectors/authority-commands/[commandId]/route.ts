/** Hosted managed connector authority status endpoint. */
import { z } from 'zod';

import { getManagedAuthorityCommandStatus } from '@/lib/connectors/managed/authority-service';
import {
  managedContextFailure,
  resolveManagedConnectorRequest,
} from '@/lib/connectors/managed/request-context';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CommandIdSchema = z.string().min(1).max(200);

/** Read one durable authority status beneath the verified tenant and instance. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ commandId: string }> }
): Promise<Response> {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  const commandId = CommandIdSchema.safeParse((await params).commandId);
  if (!commandId.success) return Response.json({ error: 'not_found' }, { status: 404 });
  const status = await getManagedAuthorityCommandStatus(
    context.db,
    context.principal,
    commandId.data
  );
  return status ? Response.json(status) : Response.json({ error: 'not_found' }, { status: 404 });
}
