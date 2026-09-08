/** Exact-version receive metadata for authenticated linked instances. */
import { z } from 'zod';
import {
  resolveManagedConnectorRequest,
  managedContextFailure,
} from '@/lib/connectors/managed/request-context';
import { listManagedEventDefinitions } from '@/lib/connectors/managed/event-discovery-service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const Query = z
  .object({
    toolkit: z.string().min(1).max(128),
    toolkitVersion: z
      .string()
      .min(1)
      .max(128)
      .refine((value) => value !== 'latest'),
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(100),
  })
  .strict();

/** Discover current exact event identities without creating an upstream subscription. */
export async function GET(request: Request, { params }: { params: Promise<{ toolkit: string }> }) {
  const context = await resolveManagedConnectorRequest(request, 'authority');
  if (context.status !== 'ok') return managedContextFailure(context);
  if (!context.events) return Response.json({ error: 'events_unavailable' }, { status: 503 });
  const search = new URL(request.url).searchParams;
  if (search.has('toolkit')) return Response.json({ error: 'invalid_request' }, { status: 400 });
  const query = Query.safeParse({ ...Object.fromEntries(search), toolkit: (await params).toolkit });
  if (!query.success) return Response.json({ error: 'invalid_request' }, { status: 400 });
  try {
    return Response.json(
      await listManagedEventDefinitions(context, { ...query.data, signal: request.signal })
    );
  } catch {
    return Response.json({ error: 'events_unavailable' }, { status: 503 });
  }
}
