/** Raw signed project webhook ingress; no tenant/account lookup occurs before verification. */
import { ComposioWebhookVerifier } from '@dorkos/connector-providers/composio';
import { CONNECTOR_EVENT_MAX_RAW_BYTES } from '@dorkos/shared/connector-event-schemas';
import { getDb } from '@/db/client';
import { readManagedConnectorConfig } from '@/lib/connectors/managed/config';
import { managedEventProtector } from '@/lib/connectors/managed/event-protection';
import { acceptManagedConnectorEvent } from '@/lib/connectors/managed/event-ingress-service';
import { sweepManagedConnectorEventRetention } from '@/lib/connectors/managed/event-delivery-service';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Verify bounded raw bytes, then resolve existing tenant-owned subscriptions and persist before ACK. */
export async function POST(request: Request): Promise<Response> {
  if (
    !/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '') ||
    ![null, 'identity'].includes(request.headers.get('content-encoding'))
  )
    return Response.json({ error: 'unsupported_encoding' }, { status: 415 });
  try {
    const config = readManagedConnectorConfig();
    const protector = managedEventProtector();
    if (
      !config.enabled ||
      !config.liveReady ||
      !config.eventsLiveReady ||
      !config.projectApiKey ||
      !config.webhookSecret ||
      !protector
    )
      return Response.json({ error: 'events_unavailable' }, { status: 503 });
    const reader = request.body?.getReader();
    if (!reader) return Response.json({ error: 'invalid_request' }, { status: 400 });
    const chunks: Uint8Array[] = [];
    let size = 0;
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > CONNECTOR_EVENT_MAX_RAW_BYTES) {
        await reader.cancel();
        return Response.json({ error: 'event_too_large' }, { status: 413 });
      }
      chunks.push(next.value);
    }
    const verifier = new ComposioWebhookVerifier(config.webhookSecret, config.projectApiKey);
    const verified = await verifier.verifyWebhook({
      rawBody: Buffer.concat(chunks),
      webhookId: request.headers.get('webhook-id') ?? '',
      webhookTimestamp: request.headers.get('webhook-timestamp') ?? '',
      webhookSignature: request.headers.get('webhook-signature') ?? '',
    });
    if (verified.status !== 'verified')
      return Response.json({ error: 'invalid_signature' }, { status: 401 });
    const db = getDb();
    await sweepManagedConnectorEventRetention(db);
    const result = await acceptManagedConnectorEvent(db, verified.event, protector);
    return result === 'accepted'
      ? Response.json({ accepted: true }, { status: 202 })
      : Response.json({ error: 'binding_rejected' }, { status: 403 });
  } catch {
    return Response.json({ error: 'events_unavailable' }, { status: 503 });
  }
}
