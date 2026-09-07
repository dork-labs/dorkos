import express from 'express';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startTestComposioFixture } from '../fixture.js';
import {
  COMPOSIO_FIXTURE_KEY,
  COMPOSIO_FIXTURE_WEBHOOK_SECRET,
  COMPOSIO_FIXTURE_VERSION,
} from '../data.js';
import { maybeCreateComposioProvider } from '../../composio.js';
import { createConnectorSignedIngress } from '../../../events/signed-ingress.js';

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(disposers.splice(0).map((close) => close()));
});
const signal = () => AbortSignal.timeout(5_000);
async function fixture() {
  const app = express();
  const server = createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  disposers.push(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing address');
  const origin = `http://127.0.0.1:${address.port}`;
  const upstream = await startTestComposioFixture({ testRuntime: true, localOrigin: origin });
  disposers.push(upstream.close);
  const provider = await maybeCreateComposioProvider({
    baseUrl: upstream.baseUrl,
    webhookSecretRef: 'file:fixture-webhook',
    credentials: {
      resolve: async (ref) => ({
        ok: true,
        secret:
          ref === 'file:fixture-webhook' ? COMPOSIO_FIXTURE_WEBHOOK_SECRET : COMPOSIO_FIXTURE_KEY,
      }),
    },
  });
  if (!provider?.events) throw new Error('Missing actual Composio events');
  const accept = vi.fn(async () => 'accepted' as const);
  app.post(
    '/api/connectors/webhooks/:providerInstanceId',
    ...createConnectorSignedIngress({ verifier: () => provider.events, accept })
  );
  app.use(express.json());
  app.use('/api/test/composio', upstream.router);
  const control = (path: string, body?: unknown) =>
    fetch(
      `${origin}/api/test/composio/${path}`,
      body === undefined
        ? {}
        : {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }
    );
  return { provider, upstream, control, accept };
}

async function connect(
  provider: NonNullable<Awaited<ReturnType<typeof maybeCreateComposioProvider>>>,
  label: string
) {
  const flow = await provider.startConnect('gmail', { label });
  expect(await provider.pollConnect(flow.flowId)).toMatchObject({ status: 'pending' });
  expect((await fetch(flow.authorizeUrl!)).status).toBe(200);
  expect(await provider.pollConnect(flow.flowId)).toMatchObject({ status: 'pending' });
  expect((await fetch(flow.authorizeUrl!, { method: 'POST' })).status).toBe(200);
  const completed = await provider.pollConnect(flow.flowId);
  if (completed.status !== 'connected' || !completed.account)
    throw new Error(`Unexpected poll ${JSON.stringify(completed)}`);
  return completed.account;
}

describe('offline Composio browser upstream', () => {
  it('drives actual management, operation SDK and event SDK clients without a vendor request', async () => {
    const nativeFetch = globalThis.fetch;
    const destinations: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname !== '127.0.0.1') throw new Error('Test attempted nonloopback network');
      destinations.push(url.origin);
      return nativeFetch(input, init);
    });
    const { provider, upstream, control, accept } = await fixture();
    expect(await provider.listToolkits()).toMatchObject([{ slug: 'gmail' }]);
    expect(await provider.resolveToolkitVersion('gmail', signal())).toMatchObject({
      toolkitVersion: COMPOSIO_FIXTURE_VERSION,
    });
    const first = await connect(provider, 'Work Gmail');
    const second = await connect(provider, 'Personal Gmail');
    expect(first.externalAccountRef).not.toBe(second.externalAccountRef);
    const operations = await provider.listOperationSchemas({
      toolkit: 'gmail',
      toolkitVersion: COMPOSIO_FIXTURE_VERSION,
      limit: 100,
      signal: signal(),
    });
    expect(operations).toMatchObject({
      status: 'ok',
      page: { operations: [{ operationSlug: 'GMAIL_FETCH_EMAILS' }] },
    });
    if (operations.status !== 'ok') throw new Error('Missing operation metadata');
    const operation = {
      ...operations.page.operations[0]!,
      id: 'operation-fixture' as never,
      discoveredAt: new Date().toISOString(),
    };
    expect(
      await provider.execute({
        operation,
        externalAccountRef: second.externalAccountRef,
        arguments: {},
        logicalOperationId: 'fixture-operation',
        attemptId: 'fixture-attempt',
        signal: signal(),
        authorizeDispatch: async () => true,
      })
    ).toMatchObject({
      status: 'success',
      data: { messages: [{ subject: 'Offline Gmail account 2' }] },
    });
    expect(destinations).toContain(upstream.baseUrl);
    const events = provider.events!;
    const definitions = await events.listDefinitions({
      toolkit: 'gmail',
      toolkitVersion: COMPOSIO_FIXTURE_VERSION,
      limit: 100,
      signal: signal(),
    });
    expect(definitions.definitions).toHaveLength(3);
    expect(definitions.definitions[1]).toMatchObject({
      deliveryMode: 'unknown',
      expectedCadenceSeconds: null,
    });
    const scope = {
      definition: definitions.definitions[0]!,
      externalAccountRef: first.externalAccountRef,
      filter: { label: 'INBOX' },
      signal: signal(),
    };
    await control('events-state', { mode: 'unavailable' });
    const beforeUnavailable = (await (await control('status')).json()).upstreamRequests;
    expect(await events.reconcileTrigger(scope)).toEqual({ status: 'unavailable' });
    expect((await (await control('status')).json()).upstreamRequests - beforeUnavailable).toBe(1);
    await control('events-state', { mode: 'ready' });
    expect(await events.reconcileTrigger(scope)).toEqual({ status: 'absent' });
    expect(
      await events.createTrigger({ ...scope, authorizeDispatch: async () => true })
    ).toMatchObject({ status: 'ready' });
    const current = await events.reconcileTrigger(scope);
    expect(current).toMatchObject({
      status: 'found',
      trigger: { externalAccountRef: first.externalAccountRef, enabled: true },
    });
    const emit = {
      accountOrdinal: 1,
      eventType: 'GMAIL_NEW_MESSAGE',
      eventId: 'offline_event_1',
      signature: 'valid',
    };
    expect(await (await control('emit', emit)).json()).toEqual({
      eventId: emit.eventId,
      status: 202,
    });
    expect(accept).toHaveBeenCalledExactlyOnceWith(
      provider.instanceId,
      expect.objectContaining({
        eventType: 'GMAIL_NEW_MESSAGE',
        externalAccountRef: first.externalAccountRef,
        envelopeVersion: 'V2',
      })
    );
    expect(await (await control('emit', { ...emit, signature: 'invalid' })).json()).toMatchObject({
      status: 401,
    });
    expect(accept).toHaveBeenCalledTimes(1);
    expect((await control('emit', { ...emit, accountOrdinal: 2 })).status).toBe(409);
    expect((await control('emit', { ...emit, url: 'https://example.com' })).status).toBe(400);
    const mutationsBefore = (await (await control('status')).json()).mutations;
    for (const body of [
      {
        connected_account_id: 'missing',
        user_id: 'dorkos-operator',
        toolkit_versions: { gmail: COMPOSIO_FIXTURE_VERSION },
        trigger_config: {},
      },
      {
        connected_account_id: first.externalAccountRef.replace('composio:', ''),
        user_id: 'another-owner',
        toolkit_versions: { gmail: COMPOSIO_FIXTURE_VERSION },
        trigger_config: {},
      },
      {
        connected_account_id: first.externalAccountRef.replace('composio:', ''),
        user_id: 'dorkos-operator',
        toolkit_versions: { gmail: 'latest' },
        trigger_config: {},
      },
      {
        connected_account_id: first.externalAccountRef.replace('composio:', ''),
        user_id: 'dorkos-operator',
        toolkit_versions: { gmail: COMPOSIO_FIXTURE_VERSION },
        trigger_config: { arbitrary: true },
      },
    ])
      expect(
        (
          await fetch(`${upstream.baseUrl}/api/v3.1/trigger_instances/GMAIL_NEW_MESSAGE/upsert`, {
            method: 'POST',
            headers: { 'x-api-key': COMPOSIO_FIXTURE_KEY, 'content-type': 'application/json' },
            body: JSON.stringify(body),
          })
        ).status
      ).toBe(400);
    expect((await (await control('status')).json()).mutations).toBe(mutationsBefore);
    expect(
      (
        await fetch(`${upstream.baseUrl}/unknown`, {
          headers: { 'x-api-key': COMPOSIO_FIXTURE_KEY },
        })
      ).status
    ).toBe(404);
    expect(
      (await fetch(`${upstream.baseUrl}/api/v3.1/toolkits`, { headers: { 'x-api-key': 'wrong' } }))
        .status
    ).toBe(401);
  });
  it('requires the existing test gate and rejects any nonlocal destination before opening a listener', async () => {
    await expect(
      startTestComposioFixture({ testRuntime: false, localOrigin: 'http://127.0.0.1:1' })
    ).rejects.toThrow('test runtime');
    for (const localOrigin of [
      'https://example.com',
      'http://127.0.0.1@evil.test',
      'http://localhost:1/path',
      'http://localhost:1?x=1',
    ])
      await expect(startTestComposioFixture({ testRuntime: true, localOrigin })).rejects.toThrow(
        'loopback origin'
      );
  });
  it('closes only its owned offline listener', async () => {
    const first = await startTestComposioFixture({
      testRuntime: true,
      localOrigin: 'http://127.0.0.1:1',
    });
    const second = await startTestComposioFixture({
      testRuntime: true,
      localOrigin: 'http://127.0.0.1:1',
    });
    disposers.push(first.close, second.close);
    await first.close();
    await expect(
      fetch(`${first.baseUrl}/api/v3.1/toolkits`, { signal: AbortSignal.timeout(1_000) })
    ).rejects.toThrow();
    expect(
      (
        await fetch(`${second.baseUrl}/api/v3.1/toolkits`, {
          headers: { 'x-api-key': COMPOSIO_FIXTURE_KEY },
        })
      ).status
    ).toBe(200);
  });
  it('keeps production construction outside the dynamic fixture and closes it on startup failure', () => {
    const source = readFileSync(new URL('../../../../../index.ts', import.meta.url), 'utf8');
    expect(source).toMatch(
      /if \(env\.DORKOS_TEST_RUNTIME\) \{\s*const \{ startTestComposioFixture \}/
    );
    expect(source).toMatch(
      /start\(\)\.catch\(async \(err\) => \{[\s\S]*?await testComposioFixture\?\.close\(\)/
    );
    expect(source).toMatch(
      /async function shutdownServices\(\) \{[\s\S]*?await testComposioFixture\?\.close\(\)/
    );
  });
});
