import { createHmac } from 'node:crypto';
import { createServer, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ComposioEventClient } from '../event-client.js';

const secret = 'whsec_literal_fixture';
const version = '20260901_00';
const signal = () => new AbortController().signal;
const metadata = (type: string | undefined = 'poll') => ({
  slug: 'GMAIL_NEW_MESSAGE',
  name: 'New message',
  description: 'A new message',
  toolkit: { slug: 'gmail', name: 'Gmail', logo: '' },
  version,
  config: { type: 'object', properties: { label: { type: 'string' } } },
  payload: { type: 'object' },
  type,
});
const fixtures: Array<() => Promise<void>> = [];

async function fixture(handler?: (path: string, response: ServerResponse) => boolean) {
  const requests: Array<{ method: string; path: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const path = request.url ?? '';
    requests.push({
      method: request.method!,
      path,
      body: chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null,
    });
    response.setHeader('content-type', 'application/json');
    if (handler?.(path, response)) return;
    if (path.startsWith('/api/v3.1/triggers_types/GMAIL_NEW_MESSAGE'))
      response.end(JSON.stringify(metadata()));
    else if (path.startsWith('/api/v3.1/triggers_types'))
      response.end(JSON.stringify({ items: [metadata()], total_pages: 1, current_page: 1 }));
    else if (path.includes('/upsert'))
      response.end(JSON.stringify({ trigger_id: 'trigger_shared' }));
    else {
      response.statusCode = 599;
      response.end('{}');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing fixture address');
  fixtures.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const client = new ComposioEventClient({
    apiKey: 'fixture-key',
    serverUserId: 'user-exact',
    webhookSecret: secret,
    baseUrl: `http://127.0.0.1:${address.port}`,
  });
  return { client, requests };
}

function signed(
  body: unknown,
  id = 'msg_delivery',
  timestamp = String(Math.floor(Date.now() / 1000))
) {
  const payload = JSON.stringify(body);
  return {
    rawBody: new TextEncoder().encode(payload),
    webhookId: id,
    webhookTimestamp: timestamp,
    webhookSignature: `v1,${createHmac('sha256', secret).update(`${id}.${timestamp}.${payload}`).digest('base64')}`,
  };
}
const v1 = {
  trigger_name: 'GMAIL_NEW_MESSAGE',
  connection_id: 'account-exact',
  trigger_id: 'trigger_shared',
  payload: { subject: 'Private message' },
  log_id: 'log-private',
};

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(fixtures.splice(0).map((close) => close()));
});

describe('Composio event SDK boundary', () => {
  it.each([
    ['poll', 'polling'],
    ['webhook', 'webhook'],
    [undefined, 'unknown'],
  ] as const)('preserves %s metadata and unknown cadence', async (mode, expected) => {
    const local = await fixture((path, response) => {
      if (!path.startsWith('/api/v3.1/triggers_types')) return false;
      response.end(
        JSON.stringify({ items: [{ ...metadata(), type: mode }], total_pages: 1, current_page: 1 })
      );
      return true;
    });
    const page = await local.client.listDefinitions({
      toolkit: 'gmail',
      toolkitVersion: version,
      limit: 20,
      signal: signal(),
    });
    expect(page.definitions).toHaveLength(1);
    expect(page.definitions[0]).toMatchObject({
      deliveryMode: expected,
      expectedCadenceSeconds: null,
      toolkitVersion: version,
    });
    expect(local.requests).toHaveLength(1);
    expect(local.requests[0].path).toContain('toolkit_versions%5Bgmail%5D=20260901_00');
  });

  it('revalidates authority after metadata and sends one exact-account mutation with unproven ownership', async () => {
    const local = await fixture();
    const definition = (
      await local.client.listDefinitions({
        toolkit: 'gmail',
        toolkitVersion: version,
        limit: 20,
        signal: signal(),
      })
    ).definitions[0];
    const guard = vi.fn(() => {
      expect(local.requests).toHaveLength(2);
      return true;
    });
    const result = await local.client.createTrigger({
      externalAccountRef: 'account-exact',
      definition,
      filter: { label: 'work' },
      signal: signal(),
      authorizeDispatch: guard,
    });
    expect(result).toEqual({
      status: 'ready',
      providerTriggerRef: 'trigger_shared',
      ownership: 'unproven',
    });
    expect(guard).toHaveBeenCalledTimes(1);
    expect(local.requests.at(-1)).toMatchObject({
      method: 'POST',
      body: {
        connected_account_id: 'account-exact',
        user_id: 'user-exact',
        toolkit_versions: { gmail: version },
        trigger_config: { label: 'work' },
      },
    });
    expect(local.requests).toHaveLength(3);
  });

  it('sends no mutation when authority changes during metadata preflight', async () => {
    const local = await fixture();
    const definition = (
      await local.client.listDefinitions({
        toolkit: 'gmail',
        toolkitVersion: version,
        limit: 20,
        signal: signal(),
      })
    ).definitions[0];
    const result = await local.client.createTrigger({
      externalAccountRef: 'account-exact',
      definition,
      filter: {},
      signal: signal(),
      authorizeDispatch: () => false,
    });
    expect(result).toEqual({ status: 'denied', code: 'AUTHORITY_CHANGED' });
    expect(local.requests.map((r) => r.method)).toEqual(['GET', 'GET']);
  });

  it('does not retry a provider write after ambiguous failure', async () => {
    const local = await fixture((path, response) => {
      if (!path.includes('/upsert')) return false;
      response.statusCode = 503;
      response.end('{}');
      return true;
    });
    const definition = (
      await local.client.listDefinitions({
        toolkit: 'gmail',
        toolkitVersion: version,
        limit: 20,
        signal: signal(),
      })
    ).definitions[0];
    expect(
      await local.client.createTrigger({
        externalAccountRef: 'account-exact',
        definition,
        filter: {},
        signal: signal(),
        authorizeDispatch: () => true,
      })
    ).toEqual({ status: 'outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN' });
    expect(local.requests.filter((r) => r.method === 'POST')).toHaveLength(1);
  });

  it('uses authenticated delivery identity rather than shared normalized trigger ID', async () => {
    const local = await fixture();
    const first = await local.client.verifyWebhook(signed(v1, 'msg_one'));
    const second = await local.client.verifyWebhook(signed(v1, 'msg_two'));
    expect(first).toMatchObject({
      status: 'verified',
      event: {
        envelopeVersion: 'V1',
        authenticatedWebhookId: 'msg_one',
        providerTriggerRef: 'trigger_shared',
        externalAccountRef: 'account-exact',
      },
    });
    expect(second).toMatchObject({
      status: 'verified',
      event: { authenticatedWebhookId: 'msg_two', providerTriggerRef: 'trigger_shared' },
    });
    expect(local.requests).toHaveLength(0);
  });

  it('retains exact V2 nano and UUID pairs and rejects V3', async () => {
    const local = await fixture();
    expect(
      await local.client.verifyWebhook(
        signed({
          type: 'gmail_new_message',
          timestamp: '2026-09-07T00:00:00Z',
          log_id: 'log',
          data: {
            connection_id: 'account-uuid',
            connection_nano_id: 'account-nano',
            trigger_id: 'trigger-uuid',
            trigger_nano_id: 'trigger-nano',
            user_id: 'user-exact',
            subject: 'Hello',
          },
        })
      )
    ).toMatchObject({
      status: 'verified',
      event: {
        envelopeVersion: 'V2',
        providerTriggerRef: 'trigger-nano',
        providerTriggerUuid: 'trigger-uuid',
        externalAccountRef: 'account-nano',
        externalAccountUuid: 'account-uuid',
        providerUserRef: 'user-exact',
      },
    });
    expect(
      await local.client.verifyWebhook(
        signed({
          id: 'event-v3',
          timestamp: '2026-09-07T00:00:00Z',
          type: 'composio.connected_account.expired',
          metadata: {},
          data: {},
        })
      )
    ).toEqual({ status: 'rejected', code: 'UNSUPPORTED_ENVELOPE' });
  });

  it.each(['prefix', 'stale', 'future', 'bad-signature', 'oversize', 'utf8'] as const)(
    'rejects %s before any provider request',
    async (kind) => {
      const local = await fixture();
      const input = signed(v1);
      if (kind === 'prefix') input.webhookTimestamp += 'junk';
      if (kind === 'stale')
        Object.assign(
          input,
          signed(v1, 'msg_delivery', String(Math.floor(Date.now() / 1000) - 301))
        );
      if (kind === 'future')
        Object.assign(
          input,
          signed(v1, 'msg_delivery', String(Math.floor(Date.now() / 1000) + 301))
        );
      if (kind === 'bad-signature') input.webhookSignature = 'v1,ZmFrZQ==';
      if (kind === 'oversize') input.rawBody = new Uint8Array(256 * 1024 + 1);
      if (kind === 'utf8') input.rawBody = new Uint8Array([0xff]);
      const result = await local.client.verifyWebhook(input);
      expect(result.status).toBe('rejected');
      expect(JSON.stringify(result)).not.toContain('Private message');
      expect(local.requests).toHaveLength(0);
    }
  );
});
