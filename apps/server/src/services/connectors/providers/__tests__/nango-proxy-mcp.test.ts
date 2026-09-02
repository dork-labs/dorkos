import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { NangoProxyMcp } from '../nango-proxy-mcp.js';
import type { NangoHttpClient, NangoProxyRequest, NangoProxyResponse } from '../nango-client.js';

/** A NangoHttpClient whose proxy surface is scripted; Auth methods are unused here. */
function fakeClient(
  proxy: (input: NangoProxyRequest) => Promise<NangoProxyResponse>
): NangoHttpClient {
  return {
    listIntegrations: () => Promise.resolve([]),
    initiateConnection: () => Promise.reject(new Error('not used')),
    getConnectionState: () => Promise.reject(new Error('not used')),
    listConnections: () => Promise.resolve([]),
    deleteConnection: () => Promise.resolve(),
    proxyRequest: proxy,
  };
}

/** Register one account and return app + its endpoint path + bearer token. */
function mountedAccount(proxy: (input: NangoProxyRequest) => Promise<NangoProxyResponse>) {
  const wrapper = new NangoProxyMcp({ localOrigin: 'http://127.0.0.1:4242' });
  const connection = wrapper.connectionForAccount(
    'nango:conn_1',
    { integration: 'gmail', connectionId: 'conn_1', label: 'work' },
    fakeClient(proxy)
  );
  const app = express();
  app.use(express.json());
  app.use('/api/connectors/nango/mcp', wrapper.createRouter());

  const http = connection as { url: string; headers: Record<string, string> };
  const path = new URL(http.url).pathname;
  const token = http.headers.authorization;
  return { wrapper, app, path, token };
}

/** The JSON-RPC body for one tools/call of proxy_request. */
function toolCall(args: Record<string, unknown>) {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'proxy_request', arguments: args },
  };
}

/** POST a JSON-RPC message with MCP's required Accept header. */
function rpc(app: express.Express, path: string, token: string | undefined, body: unknown) {
  const req = request(app)
    .post(path)
    .set('accept', 'application/json, text/event-stream')
    .send(body as object);
  return token ? req.set('authorization', token) : req;
}

/** Parse the first JSON-RPC response out of an SSE or JSON MCP reply. */
function parseRpcResponse(res: request.Response): {
  result?: { content: { type: string; text: string }[]; isError?: boolean };
} {
  const text = res.text;
  const dataLine = text.split('\n').find((line) => line.startsWith('data: '));
  return JSON.parse(dataLine ? dataLine.slice('data: '.length) : text);
}

describe('NangoProxyMcp — bearer gate', () => {
  it('401s without a token, with a wrong token, and for an unregistered account', async () => {
    const { app, path } = mountedAccount(() => Promise.resolve({ status: 200, body: '' }));

    const noToken = await rpc(app, path, undefined, toolCall({ method: 'GET', path: 'x' }));
    expect(noToken.status).toBe(401);

    const wrongToken = await rpc(
      app,
      path,
      'Bearer 0000000000000000000000000000000000000000000000000000000000000000',
      toolCall({ method: 'GET', path: 'x' })
    );
    expect(wrongToken.status).toBe(401);

    const unknownAccount = await rpc(
      app,
      '/api/connectors/nango/mcp/nango%3Aconn_other',
      'Bearer whatever',
      toolCall({ method: 'GET', path: 'x' })
    );
    expect(unknownAccount.status).toBe(401);
  });

  // The header is parsed BEFORE any credential is checked, so its parser is
  // the one piece of this endpoint an unauthenticated caller reaches. The old
  // `/^Bearer\s+(.+)$/i` was quadratic — `\s+` and `.` both match a space, so a
  // long run has many splits to try (CodeQL js/polynomial-redos). The rewrite
  // requires the credential to START with a non-space, which kills the
  // ambiguity. The one value that parses differently is a whitespace-only
  // credential, and these cases show why that costs nothing.
  it.each([
    ['a whitespace-only credential', `Bearer${' '.repeat(8)}`],
    ['a tab-only credential', 'Bearer\t\t'],
    ['a long run of spaces and nothing else', `Bearer${' '.repeat(4_000)}`],
    ['a long run of spaces before a wrong token', `Bearer${' '.repeat(4_000)}nope`],
  ])('401s on %s', async (_label, header) => {
    const { app, path } = mountedAccount(() => Promise.resolve({ status: 200, body: '' }));
    const started = performance.now();
    const res = await rpc(app, path, header, toolCall({ method: 'GET', path: 'x' }));
    const elapsed = performance.now() - started;
    expect(res.status).toBe(401);
    // Whatever the parser does with these, it must not sit there doing it.
    expect(elapsed).toBeLessThan(500);
  });

  it('still accepts the real token, including with extra whitespace after the scheme', async () => {
    const { app, path, token } = mountedAccount(() => Promise.resolve({ status: 200, body: 'ok' }));
    const bare = token.replace(/^Bearer\s+/i, '');
    for (const header of [token, `Bearer   ${bare}`, `bearer\t${bare}`]) {
      const res = await rpc(app, path, header, toolCall({ method: 'GET', path: 'x' }));
      expect(res.status, `header ${JSON.stringify(header.slice(0, 12))}…`).toBe(200);
    }
  });

  it('keeps the same token across re-registration (a live session connection stays valid)', () => {
    const wrapper = new NangoProxyMcp({ localOrigin: 'http://127.0.0.1:4242' });
    const client = fakeClient(() => Promise.resolve({ status: 200, body: '' }));
    const first = wrapper.connectionForAccount(
      'nango:conn_1',
      { integration: 'gmail', connectionId: 'conn_1', label: 'work' },
      client
    ) as { headers: Record<string, string> };
    const second = wrapper.connectionForAccount(
      'nango:conn_1',
      { integration: 'gmail', connectionId: 'conn_1', label: 'work' },
      client
    ) as { headers: Record<string, string> };
    expect(second.headers.authorization).toBe(first.headers.authorization);
  });

  it('clear() forgets every account, so a previously-valid token 401s (credential revoked)', async () => {
    const { wrapper, app, path, token } = mountedAccount(() =>
      Promise.resolve({ status: 200, body: '' })
    );
    const before = await rpc(app, path, token, toolCall({ method: 'GET', path: 'x' }));
    expect(before.status).toBe(200);

    wrapper.clear();

    const after = await rpc(app, path, token, toolCall({ method: 'GET', path: 'x' }));
    expect(after.status).toBe(401);
  });

  it('GET is 405 — the endpoint is stateless per request', async () => {
    const { app, path, token } = mountedAccount(() => Promise.resolve({ status: 200, body: '' }));
    const res = await request(app).get(path).set('authorization', token);
    expect(res.status).toBe(405);
  });
});

describe('NangoProxyMcp — the generic proxy_request tool', () => {
  it('forwards the call with the account routing and returns the upstream status + body', async () => {
    const seen: NangoProxyRequest[] = [];
    const { app, path, token } = mountedAccount((input) => {
      seen.push(input);
      return Promise.resolve({ status: 200, body: '{"threads":[]}' });
    });

    const res = await rpc(
      app,
      path,
      token,
      toolCall({ method: 'GET', path: 'gmail/v1/users/me/threads', query: { maxResults: '3' } })
    );
    expect(res.status).toBe(200);
    const parsed = parseRpcResponse(res);
    expect(parsed.result?.isError).toBeUndefined();
    const payload = JSON.parse(parsed.result!.content[0]!.text) as {
      status: number;
      body: string;
    };
    expect(payload.status).toBe(200);
    expect(payload.body).toBe('{"threads":[]}');
    // The account routing is supplied by the wrapper, never by the caller.
    expect(seen[0]).toMatchObject({ integration: 'gmail', connectionId: 'conn_1' });
  });

  it('size-caps a huge upstream body with an honest truncation notice', async () => {
    const huge = 'x'.repeat(150_000);
    const { app, path, token } = mountedAccount(() => Promise.resolve({ status: 200, body: huge }));

    const res = await rpc(app, path, token, toolCall({ method: 'GET', path: 'big' }));
    const parsed = parseRpcResponse(res);
    const payload = JSON.parse(parsed.result!.content[0]!.text) as { body: string };
    expect(payload.body.length).toBeLessThan(101_000);
    expect(payload.body).toContain('[truncated');
  });

  it('surfaces an upstream 4xx as a tool error carrying the honest status', async () => {
    const { app, path, token } = mountedAccount(() =>
      Promise.resolve({ status: 403, body: 'forbidden' })
    );
    const res = await rpc(app, path, token, toolCall({ method: 'GET', path: 'x' }));
    const parsed = parseRpcResponse(res);
    expect(parsed.result?.isError).toBe(true);
    const payload = JSON.parse(parsed.result!.content[0]!.text) as { status: number };
    expect(payload.status).toBe(403);
  });

  it('maps a transport failure to a secret-free tool error, never a throw', async () => {
    const { app, path, token } = mountedAccount(() =>
      Promise.reject(new Error('fetch failed: connect ECONNREFUSED'))
    );
    const res = await rpc(app, path, token, toolCall({ method: 'GET', path: 'x' }));
    const parsed = parseRpcResponse(res);
    expect(parsed.result?.isError).toBe(true);
    expect(parsed.result!.content[0]!.text).toContain('ECONNREFUSED');
  });

  it('never echoes a secret: responses carry no bearer token and no Nango key', async () => {
    const { app, path, token } = mountedAccount(() =>
      Promise.resolve({ status: 200, body: '{"ok":true}' })
    );
    const res = await rpc(app, path, token, toolCall({ method: 'GET', path: 'x' }));
    const raw = res.text;
    // The per-account bearer (from the connection header) must not round-trip.
    expect(raw).not.toContain(token.replace(/^Bearer /, ''));
    expect(raw).not.toContain('sk-nango');
  });

  it('names the service and label in the tool description (honest tool surface)', async () => {
    const { app, path, token } = mountedAccount(() => Promise.resolve({ status: 200, body: '' }));
    const res = await rpc(app, path, token, {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const parsed = parseRpcResponse(res) as unknown as {
      result: { tools: { name: string; description: string }[] };
    };
    expect(parsed.result.tools).toHaveLength(1);
    const tool = parsed.result.tools[0]!;
    expect(tool.name).toBe('proxy_request');
    expect(tool.description).toContain('gmail (work)');
    expect(tool.description).toContain('Nango');
  });
});
