/**
 * The thin client's behaviour at the seams: the wire header, bearer auth, the
 * problem envelope, and the two ways a response can be wrong.
 *
 * Every case injects its own `fetch`. Nothing here opens a socket, and the
 * package bakes in no origin to open one to.
 */
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  CloudApiProblemError,
  CloudApiResponseError,
  createCloudApiClient,
  isCloudApiProblemError,
} from '../client.js';
import { HostedPageResponseSchema, RefundResponseSchema } from '../billing.js';
import { V1_ROUTES } from '../routes.js';
import { SessionSchema } from '../session.js';
import { WIRE_VERSION_HEADER } from '../primitives.js';

const signedOut = { authenticated: false, scopes: [] };

/**
 * A `fetch` that answers once with the given status and body.
 *
 * @param status - The HTTP status to answer with.
 * @param body - The body, serialized as JSON unless it is already a string.
 */
function respondWith(status: number, body: unknown) {
  return vi.fn(
    async (_input: string, _init?: RequestInit) =>
      new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })
  );
}

describe('createCloudApiClient', () => {
  it('sends the wire header and the bearer token, and joins the path to the base URL', async () => {
    const fetchMock = respondWith(200, signedOut);
    const client = createCloudApiClient({
      baseUrl: 'https://example.invalid/',
      token: 'tok_0001',
      fetch: fetchMock,
    });

    await client.get(V1_ROUTES.session, SessionSchema);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    // The trailing slash on the base URL is trimmed, so no `//v1/session`.
    expect(url).toBe('https://example.invalid/v1/session');
    const headers = init.headers as Record<string, string>;
    expect(headers[WIRE_VERSION_HEADER.toLowerCase()]).toBe('1');
    expect(headers.authorization).toBe('Bearer tok_0001');
  });

  it('resolves a token supplied as a function, so a refresh can happen per call', async () => {
    const fetchMock = respondWith(200, signedOut);
    const token = vi.fn(async () => 'tok_0002');
    const client = createCloudApiClient({
      baseUrl: 'https://example.invalid',
      token,
      fetch: fetchMock,
    });

    await client.get(V1_ROUTES.session, SessionSchema);
    await client.get(V1_ROUTES.session, SessionSchema);

    expect(token).toHaveBeenCalledTimes(2);
  });

  it('sends no authorization header when there is no token', async () => {
    const fetchMock = respondWith(200, signedOut);
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    await client.get(V1_ROUTES.session, SessionSchema);

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(headers.authorization).toBeUndefined();
  });

  it('drops undefined query values instead of sending the string "undefined"', async () => {
    const fetchMock = respondWith(200, { period: '2026-08' });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    await client.get(V1_ROUTES.statement, z.object({ period: z.string() }), {
      query: { period: '2026-08', cursor: undefined },
    });

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://example.invalid/v1/statement?period=2026-08'
    );
  });

  it('throws the parsed problem envelope on a refusal', async () => {
    const fetchMock = respondWith(402, {
      code: 'balance_exhausted',
      status: 402,
      title: 'You are out of credit.',
    });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    const error = await client.get(V1_ROUTES.session, SessionSchema).catch((caught) => caught);

    expect(isCloudApiProblemError(error)).toBe(true);
    expect((error as CloudApiProblemError).problem.code).toBe('balance_exhausted');
  });

  it('distinguishes a non-Problem failure body from a Problem one', async () => {
    // A service bug and a contract refusal need different follow-up, so they
    // are different error classes rather than one with a flag.
    const fetchMock = respondWith(500, { oops: true });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    const error = await client.get(V1_ROUTES.session, SessionSchema).catch((caught) => caught);

    expect(error).toBeInstanceOf(CloudApiResponseError);
    expect((error as CloudApiResponseError).status).toBe(500);
  });

  it('rejects a success body that does not match the contract', async () => {
    // Usually this means the client is older than the contract being served.
    const fetchMock = respondWith(200, { authenticated: 'yes' });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    await expect(client.get(V1_ROUTES.session, SessionSchema)).rejects.toBeInstanceOf(
      CloudApiResponseError
    );
  });

  it('treats 204 as an empty body rather than parsing "" as JSON', async () => {
    const fetchMock = vi.fn(
      async (_input: string, _init?: RequestInit) => new Response(null, { status: 204 })
    );
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    await expect(client.delete('/v1/remote/enrolment', z.undefined())).resolves.toBeUndefined();
  });

  it('reports a non-JSON body as a response error, not a parse crash', async () => {
    const fetchMock = respondWith(200, '<html>a proxy error page</html>');
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    await expect(client.get(V1_ROUTES.session, SessionSchema)).rejects.toBeInstanceOf(
      CloudApiResponseError
    );
  });

  it('lets a caller override a header whatever its casing, instead of duplicating it', async () => {
    // HTTP header names are case-insensitive, and `Headers` joins duplicates
    // with a comma — so a caller's `Authorization` beside the client's
    // `authorization` yields `Bearer caller, Bearer client`, which no service
    // accepts. Merging is case-folded so the caller's value replaces it.
    const fetchMock = respondWith(200, signedOut);
    const client = createCloudApiClient({
      baseUrl: 'https://example.invalid',
      token: 'tok_client',
      fetch: fetchMock,
    });

    await client.get(V1_ROUTES.session, SessionSchema, {
      headers: { Authorization: 'Bearer tok_caller', Accept: 'application/problem+json' },
    });

    const headers = (fetchMock.mock.calls[0] as [string, RequestInit])[1].headers as Record<
      string,
      string
    >;
    expect(Object.keys(headers).filter((key) => key.toLowerCase() === 'authorization')).toEqual([
      'authorization',
    ]);
    expect(headers.authorization).toBe('Bearer tok_caller');
    expect(headers.accept).toBe('application/problem+json');
  });

  it('posts a top-up amount as the contract spells it, and gets a hosted page back', async () => {
    // The amount crosses the wire as an exact integer of micro-units in a
    // string. A client that hands the body a number never reaches the service:
    // the request schema refuses it first.
    const fetchMock = respondWith(200, { url: 'https://pay.example.invalid/session/0001' });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    const page = await client.post(V1_ROUTES.topup, HostedPageResponseSchema, {
      body: { amountMicro: '20000000' },
    });

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.invalid/v1/topup');
    expect(init.body).toBe('{"amountMicro":"20000000"}');
    expect(page.url).toBe('https://pay.example.invalid/session/0001');
  });

  it('surfaces a refusal below the minimum as the contract`s own code', async () => {
    // `topup_below_minimum` replaces the stand-ins a client used to have to
    // interpret, so an interface can say what actually happened.
    const fetchMock = respondWith(422, {
      code: 'topup_below_minimum',
      status: 422,
      title: 'That is under the smallest top-up.',
    });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    const error = await client
      .post(V1_ROUTES.topup, HostedPageResponseSchema, { body: { amountMicro: '1' } })
      .catch((caught) => caught);

    expect(isCloudApiProblemError(error)).toBe(true);
    expect((error as CloudApiProblemError).problem.code).toBe('topup_below_minimum');
  });

  it('asks for a refund by opaque charge identifier', async () => {
    const fetchMock = respondWith(200, {
      refundId: 'rfnd_0001',
      chargeId: 'chg_0001',
      refundedMicro: '20000000',
      refundedAt: '2026-09-15T12:00:00.000Z',
    });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    const refund = await client.post(V1_ROUTES.refunds, RefundResponseSchema, {
      body: { chargeId: 'chg_0001' },
    });

    expect((fetchMock.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://example.invalid/v1/refunds'
    );
    expect(refund.refundId).toBe('rfnd_0001');
  });

  it('sets a JSON content type only when there is a body', async () => {
    const fetchMock = respondWith(200, { revoked: true });
    const client = createCloudApiClient({ baseUrl: 'https://example.invalid', fetch: fetchMock });

    await client.post(V1_ROUTES.instancesRevoke, z.object({ revoked: z.boolean() }), {
      body: { instanceId: 'inst_0001' },
    });

    const init = (fetchMock.mock.calls[0] as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(init.body).toBe('{"instanceId":"inst_0001"}');
  });
});
