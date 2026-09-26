/**
 * @vitest-environment node
 */
import { describe, expect, it, vi } from 'vitest';
import { FlyGraphqlClientError, FlyTigrisGraphqlClient } from '../fly-graphql-client.js';

const identity = {
  id: 'addon_fixture_01',
  name: 'community-fixture-bucket',
  status: 'ready',
  options: { public: false },
  organization: { slug: 'fixture-org' },
  addOnProvider: { name: 'tigris' },
  app: { id: 'app_fixture_01', name: 'community-fixture-app' },
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function createInput() {
  return {
    clientMutationId: 'run_01',
    appId: 'app_fixture_01',
    organizationId: 'org_fixture_01',
    name: 'community-fixture-bucket',
    primaryRegion: 'ord',
  };
}

describe('Fly Tigris GraphQL HTTP boundary', () => {
  it('uses the fixed endpoint and keeps the token only in the authorization header', async () => {
    const canary = 'CANARY_FLY_ACCESS_TOKEN';
    const request = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      expect(_input).toBe('https://api.fly.io/graphql');
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${canary}`);
      expect(init?.body).not.toContain(canary);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        variables: { provider: 'tigris' },
      });
      return json({ data: { viewer: { agreedToProviderTos: true } } });
    });
    const client = new FlyTigrisGraphqlClient({ accessToken: canary, fetch: request });

    await expect(client.hasAcceptedTerms()).resolves.toBe(true);
    expect(request).toHaveBeenCalledOnce();
  });

  it('returns only the sanitized create and exact-ID read identities', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { viewer: { agreedToProviderTos: true } } }))
      .mockResolvedValueOnce(json({ data: { createAddOn: { addOn: identity } } }))
      .mockResolvedValueOnce(json({ data: { node: identity } }));
    const client = new FlyTigrisGraphqlClient({ accessToken: 'token', fetch: request });

    await expect(client.createTigris(createInput())).resolves.toMatchObject({
      addOnId: identity.id,
      public: false,
    });
    await expect(client.readTigris(identity.id)).resolves.toMatchObject({
      addOnId: identity.id,
      organizationSlug: identity.organization.slug,
    });
    const createBody = JSON.parse(String(request.mock.calls[1][1]?.body));
    expect(createBody.variables.input).toEqual({ ...createInput(), type: 'tigris' });
    expect(JSON.parse(String(request.mock.calls[2][1]?.body)).variables).toEqual({
      id: identity.id,
    });
  });

  it('classifies malformed create output as uncertain without disclosing provider text', async () => {
    const canary = 'CANARY_PROVIDER_RESPONSE_SECRET';
    const client = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      fetch: vi
        .fn()
        .mockResolvedValueOnce(json({ data: { viewer: { agreedToProviderTos: true } } }))
        .mockResolvedValueOnce(json({ errors: [{ message: canary }] })),
    });

    await expect(client.createTigris(createInput())).rejects.toMatchObject({
      code: 'CREATION_OUTCOME_UNCERTAIN',
      message: expect.not.stringContaining(canary),
    });
  });

  it('rejects malformed secret and creation inputs without disclosing them', async () => {
    const tokenCanary = 'CANARY_TOKEN\nINJECTION';
    expect(() => new FlyTigrisGraphqlClient({ accessToken: tokenCanary })).toThrowError(
      expect.objectContaining({
        code: 'AUTH_REQUIRED',
        message: expect.not.stringContaining(tokenCanary),
      })
    );

    const inputCanary = 'CANARY_INPUT/SECRET';
    const client = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      fetch: vi.fn(),
    });
    await expect(
      client.createTigris({ ...createInput(), name: inputCanary })
    ).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: expect.not.stringContaining(inputCanary),
    });
  });

  it('fails closed on authentication, authorization, invalid reads, and oversized output', async () => {
    for (const [status, code] of [
      [401, 'AUTH_REQUIRED'],
      [403, 'ACCESS_DENIED'],
    ] as const) {
      const client = new FlyTigrisGraphqlClient({
        accessToken: 'token',
        fetch: async () => json({ secret: 'CANARY' }, status),
      });
      await expect(client.hasAcceptedTerms()).rejects.toMatchObject({ code });
    }

    const malformed = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      fetch: async () => json({ data: { viewer: {} } }),
    });
    await expect(malformed.hasAcceptedTerms()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    await expect(malformed.readTigris('unsafe/id')).rejects.toEqual(
      expect.any(FlyGraphqlClientError)
    );

    const oversized = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      maxResponseBytes: 16,
      fetch: async () => json({ data: { viewer: { agreedToProviderTos: true } } }),
    });
    await expect(oversized.hasAcceptedTerms()).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });

  it('preserves safe missing-resource classifications for read operations', async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(json({ data: { viewer: null } }))
      .mockResolvedValueOnce(json({ data: { node: null } }));
    const client = new FlyTigrisGraphqlClient({ accessToken: 'token', fetch: request });

    await expect(client.hasAcceptedTerms()).rejects.toMatchObject({
      code: 'TERMS_VIEWER_MISSING',
    });
    await expect(client.readTigris(identity.id)).rejects.toMatchObject({
      code: 'ADD_ON_MISSING',
    });
  });

  it('classifies transport failure by whether the operation could have created a resource', async () => {
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('CANARY_NETWORK_SECRET'))
      .mockResolvedValueOnce(json({ data: { viewer: { agreedToProviderTos: true } } }))
      .mockRejectedValueOnce(new Error('CANARY_NETWORK_SECRET'));
    const client = new FlyTigrisGraphqlClient({ accessToken: 'token', fetch: request });

    await expect(client.hasAcceptedTerms()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    await expect(client.createTigris(createInput())).rejects.toMatchObject({
      code: 'CREATION_OUTCOME_UNCERTAIN',
      message: expect.not.stringContaining('CANARY_NETWORK_SECRET'),
    });
  });

  it('bounds the complete response, including a body that never arrives', async () => {
    const cancel = vi.fn();
    const stalled = async () => {
      const body = new ReadableStream({
        start() {
          return undefined;
        },
        cancel,
      });
      return new Response(body, { status: 200 });
    };
    const request = vi
      .fn()
      .mockImplementationOnce(stalled)
      .mockResolvedValueOnce(json({ data: { viewer: { agreedToProviderTos: true } } }))
      .mockImplementationOnce(stalled);
    const client = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      timeoutMs: 10,
      fetch: request,
    });

    await expect(client.hasAcceptedTerms()).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
    });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(client.createTigris(createInput())).rejects.toMatchObject({
      code: 'CREATION_OUTCOME_UNCERTAIN',
    });
    expect(cancel).toHaveBeenCalledTimes(2);
  });

  it('refuses creation before accepted terms and bounds exact-name deletion', async () => {
    const refused = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      fetch: async () => json({ data: { viewer: { agreedToProviderTos: false } } }),
    });
    await expect(refused.createTigris(createInput())).rejects.toMatchObject({
      code: 'TERMS_NOT_ACCEPTED',
    });

    const request = vi.fn(async (_input: string | URL, _init?: RequestInit) =>
      json({ data: { deleteAddOn: { deletedAddOnName: identity.name } } })
    );
    const client = new FlyTigrisGraphqlClient({ accessToken: 'token', fetch: request });
    await expect(client.deleteTigris(identity.name)).resolves.toBe(identity.name);
    expect(JSON.parse(String(request.mock.calls[0][1]?.body)).variables).toEqual({
      name: identity.name,
      provider: 'tigris',
    });
  });

  it('reads one app provenance by exact name and refuses an unsafe name before any request', async () => {
    const app = {
      id: 'community-fixture-app',
      internalNumericId: 4817203,
      name: 'community-fixture-app',
      network: 'dorkos-7f3e0b9c4d2a41e8a6c5b3f1d0e9c21a',
      createdAt: '2026-09-23T10:31:07Z',
      organization: { slug: 'fixture-org' },
      machines: { totalCount: 0 },
      volumes: { totalCount: 0 },
      ipAddresses: { totalCount: 0 },
      certificates: { totalCount: 0 },
      secrets: [{ name: 'AWS_ACCESS_KEY_ID' }],
    };
    const request = vi.fn(async (_input: string | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { query: string; variables: unknown };
      expect(body.query).toContain('DorkosReadAppProvenance');
      expect(body.variables).toEqual({ name: 'community-fixture-app' });
      return json({ data: { app } });
    });
    const client = new FlyTigrisGraphqlClient({ accessToken: 'token', fetch: request });

    await expect(client.readAppProvenance('community-fixture-app')).resolves.toMatchObject({
      internalNumericId: '4817203',
      network: app.network,
      secretNames: ['AWS_ACCESS_KEY_ID'],
    });
    await expect(client.readAppProvenance('bad name')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
    expect(request).toHaveBeenCalledOnce();

    // A read never classifies a failure as a possible create.
    const failing = new FlyTigrisGraphqlClient({
      accessToken: 'token',
      fetch: vi.fn(async () => json({ data: { app: { ...app, network: 7 } } })),
    });
    await expect(failing.readAppProvenance('community-fixture-app')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
    });
  });
});
