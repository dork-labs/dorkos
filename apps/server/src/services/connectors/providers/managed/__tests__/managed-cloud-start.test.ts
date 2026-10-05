/**
 * Starting a managed connection against a fake service, through the real fetch
 * client: the way back into the app (`returnTo`, DOR-2721), a service too old
 * to know it, and refusals that trying again will not fix (DOR-2713).
 */
import { describe, expect, it, vi } from 'vitest';
import {
  ConnectStartRefusedError,
  type ConnectorProviderInstanceId,
} from '@dorkos/shared/connector-provider';
import {
  ManagedConnectorAuthenticationCreateRequestSchema,
  type ManagedConnectorAuthenticationState,
} from '@dorkos/shared/connector-managed-discovery-schemas';
import { ManagedCloudConnectorProvider, type ManagedConnectorCloudPort } from '../managed-cloud.js';
import { requestManagedConnectorAuthentication } from '../../../../core/auth/cloud-link-client.js';

const pending: ManagedConnectorAuthenticationState = {
  version: 1,
  state: 'pending',
  flowId: 'flow-1',
  toolkit: 'slack',
  authorizeUrl: 'https://cloud.example.invalid/connectors/managed/authorize?flow=flow-1',
  createdAt: '2026-10-05T00:00:00.000Z',
  expiresAt: '2026-10-05T00:10:00.000Z',
};

/** What the fake service does with the start request it receives. */
type ServiceBehaviour = (body: Record<string, unknown>) => Response;

/** A service as old as the field: the request schema without `returnTo`, read strictly. */
const olderStrictService: ServiceBehaviour = (body) =>
  ManagedConnectorAuthenticationCreateRequestSchema.omit({ returnTo: true }).safeParse(body).success
    ? Response.json(pending)
    : Response.json({ error: 'invalid_request' }, { status: 400 });

/** A service that drops keys it does not know, as a plain Zod object does. */
const olderLenientService: ServiceBehaviour = () => Response.json(pending);

const currentService: ServiceBehaviour = (body) =>
  ManagedConnectorAuthenticationCreateRequestSchema.safeParse(body).success
    ? Response.json(pending)
    : Response.json({ error: 'invalid_request' }, { status: 400 });

function harness(behaviour: ServiceBehaviour) {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    bodies.push(body);
    return behaviour(body);
  });
  const cloud = {
    startManagedConnectorAuthentication: (request, signal) =>
      requestManagedConnectorAuthentication({
        baseUrl: 'https://cloud.example.invalid',
        accessToken: 'token',
        request,
        fetchImpl,
        signal,
      }),
  } as Partial<ManagedConnectorCloudPort> as ManagedConnectorCloudPort;
  const provider = new ManagedCloudConnectorProvider({
    instanceId: 'managed:cloud' as ConnectorProviderInstanceId,
    cloud,
    executionContext: () => undefined,
  });
  return { provider, bodies };
}

describe('ManagedCloudConnectorProvider.startConnect', () => {
  it('tells the service where in the app the person started', async () => {
    const { provider, bodies } = harness(currentService);
    await expect(
      provider.startConnect('slack', { returnTo: 'dorkos://connections' })
    ).resolves.toEqual({ flowId: 'flow-1', authorizeUrl: pending.authorizeUrl });
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toMatchObject({ toolkit: 'slack', returnTo: 'dorkos://connections' });
  });

  it('sends no returnTo when there is none', async () => {
    const { provider, bodies } = harness(currentService);
    await provider.startConnect('slack', { label: 'Work' });
    expect(bodies[0]).not.toHaveProperty('returnTo');
    expect(bodies[0]).toMatchObject({ label: 'Work' });
  });

  it('still connects through a service that refuses the unknown field', async () => {
    const { provider, bodies } = harness(olderStrictService);
    await expect(
      provider.startConnect('slack', { returnTo: 'http://localhost:4242/connections' })
    ).resolves.toEqual({ flowId: 'flow-1', authorizeUrl: pending.authorizeUrl });
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).not.toHaveProperty('returnTo');
    // The same request: the refused one recorded nothing on the service side.
    expect(bodies[1]!.requestId).toBe(bodies[0]!.requestId);
  });

  it('still connects through a service that ignores the unknown field', async () => {
    const { provider, bodies } = harness(olderLenientService);
    await expect(
      provider.startConnect('slack', { returnTo: 'dorkos://connections' })
    ).resolves.toEqual({ flowId: 'flow-1', authorizeUrl: pending.authorizeUrl });
    expect(bodies).toHaveLength(1);
  });

  it('does not ask twice when the request was refused for another reason', async () => {
    const { provider, bodies } = harness(() =>
      Response.json({ error: 'invalid_request' }, { status: 400 })
    );
    await expect(provider.startConnect('slack')).rejects.not.toBeInstanceOf(
      ConnectStartRefusedError
    );
    expect(bodies).toHaveLength(1);
  });

  it('says the service is not ready when it refuses to start this app', async () => {
    const { provider } = harness(() =>
      Response.json(
        {
          error: 'unavailable',
          reason:
            'Account setup could not be confirmed. Check this service’s setup before trying again.',
        },
        { status: 503 }
      )
    );
    const error = await provider.startConnect('slack').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ConnectStartRefusedError);
    expect((error as ConnectStartRefusedError).refusal).toBe('service_not_ready');
  });

  it('says the computer must be linked when the service no longer knows it', async () => {
    const { provider } = harness(() => Response.json({ error: 'unauthorized' }, { status: 401 }));
    const error = await provider.startConnect('slack').catch((caught: unknown) => caught);
    expect((error as ConnectStartRefusedError).refusal).toBe('account_link_required');
  });

  it('leaves a bare outage as an ordinary failure that may pass on a retry', async () => {
    const { provider } = harness(() => new Response('Bad gateway', { status: 503 }));
    const error = await provider.startConnect('slack').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(ConnectStartRefusedError);
  });
});
