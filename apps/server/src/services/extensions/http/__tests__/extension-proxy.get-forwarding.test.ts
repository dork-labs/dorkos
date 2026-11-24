import {
  mockSecretGet,
  fixtureTarget,
  DEFAULT_CONFIG,
  makeReq,
  makeRes,
  rawGetStatus,
  getProxyHandler,
  proxyApp,
  st,
} from './extension-proxy.fixtures.js';
import { describe, it, expect, vi } from 'vitest';
import { PERSON_PROOF_HEADER } from '@dorkos/shared/person-session';
import request from '@dorkos/test-utils/supertest';
import type { DataProxyConfig } from '@dorkos/extension-api';
import { STRIPPED_HEADERS } from '../extension-proxy.js';
import { AGENT_IDENTITY_HEADER } from '../../../../middleware/agent-identity.js';

// --- Tests ---

describe('the extension data proxy', () => {
  describe('GET forwarding', () => {
    it('forwards GET request to upstream with auth header', async () => {
      mockSecretGet.mockResolvedValue('my-api-token');

      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"data":"hello"}'),
      });

      const handler = getProxyHandler();
      const req = makeReq();
      const res = makeRes();

      await handler(req, res);

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.objectContaining({
          method: 'GET',
          headers: expect.objectContaining({
            Authorization: 'Bearer my-api-token',
          }),
          body: undefined,
        })
      );
      expect(res._status).toBe(200);
      expect(res._body).toBe('{"data":"hello"}');
    });
  });

  describe('auth header injection', () => {
    it('formats Bearer auth correctly', async () => {
      mockSecretGet.mockResolvedValue('tok123');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authType: 'Bearer' });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer tok123' }),
        })
      );
    });

    it('uses a custom auth header name', async () => {
      mockSecretGet.mockResolvedValue('my-key');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve(''),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        authHeader: 'X-Api-Key',
        authType: 'Custom',
      });
      await handler(makeReq(), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ 'X-Api-Key': 'my-key' }),
        })
      );
    });
  });

  describe('missing secret', () => {
    it('returns 503 when secret is not configured', async () => {
      mockSecretGet.mockResolvedValue(null);

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(503);
      expect(res._body).toMatchObject({
        code: 'temporarily_unavailable',
        status: 503,
        detail: 'Set the api_key secret for this extension in Settings.',
      });
      // fetch should not have been called
      expect(globalThis.fetch).toBe(st.originalFetch);
    });
  });

  describe('upstream failure', () => {
    it('returns 502 on network error', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(502);
      expect(res._body).toMatchObject({ code: 'upstream_unavailable', status: 502 });
      // The upstream's own error stays in the server log, never in the answer.
      expect(JSON.stringify(res._body)).not.toContain('ECONNREFUSED');
    });
  });

  describe('upstream non-200 status', () => {
    it('forwards 404 status from upstream', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{"error":"Not Found"}'),
      });

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._status).toBe(404);
      expect(res._body).toBe('{"error":"Not Found"}');
    });
  });

  describe('path forwarding', () => {
    it('forwards /proxy/graphql to baseUrl/graphql', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(makeReq({ params: { splat: ['graphql'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/graphql',
        expect.any(Object)
      );
    });

    it('strips trailing slash from baseUrl before appending path', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        baseUrl: 'https://api.example.com/',
      });
      await handler(makeReq({ params: { splat: ['data'] } }), makeRes());

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/data',
        expect.any(Object)
      );
    });
  });

  describe('path rewriting', () => {
    it('applies pathRewrite rules to the target URL', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({
        ...DEFAULT_CONFIG,
        pathRewrite: { '/v1/': '/v2/' },
      });
      await handler(
        makeReq({ url: '/proxy/v1/issues', params: { splat: ['v1', 'issues'] } }),
        makeRes()
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v2/issues',
        expect.any(Object)
      );
    });
  });

  describe('header filtering', () => {
    it('strips hop-by-hop headers (host, connection)', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(
        makeReq({
          headers: {
            'content-type': 'application/json',
            host: 'localhost:6242',
            connection: 'keep-alive',
            'transfer-encoding': 'chunked',
            'x-custom': 'keep-me',
          } as Record<string, string>,
        }),
        makeRes()
      );

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('host');
      expect(callHeaders).not.toHaveProperty('connection');
      expect(callHeaders).not.toHaveProperty('transfer-encoding');
      expect(callHeaders).toHaveProperty('x-custom', 'keep-me');
    });
  });

  describe('content-type forwarding', () => {
    it('forwards content-type from upstream response', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        text: () => Promise.resolve('<html></html>'),
      });

      const handler = getProxyHandler();
      const res = makeRes();

      await handler(makeReq(), res);

      expect(res._headers['Content-Type']).toBe('text/html; charset=utf-8');
    });
  });

  // The other tests call the forwarder directly with a fake request, so they
  // can't prove the route actually matches. Drive a real request through the
  // mounted handler to confirm `/proxy/*` matches and the multi-segment
  // sub-path is rebuilt from its segments (`proxySegments`).
  describe('real route matching', () => {
    it('matches /proxy/* and forwards the full sub-path with query string', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        text: () => Promise.resolve('{}'),
      });

      await request(fixtureTarget.mount(proxyApp())).get(
        '/api/ext/test-ext/proxy/v1/issues/123?state=open'
      );

      expect(globalThis.fetch).toHaveBeenCalledWith(
        'https://api.example.com/v1/issues/123?state=open',
        expect.any(Object)
      );
    });
  });

  // The proxy authenticates itself to the upstream with the extension's own
  // stored secret. Anything the CALLER sent to prove who they are to DorkOS is
  // a credential for DorkOS, not for the upstream, and must not leave with the
  // request — the session cookie above all.
  describe('caller credentials are not forwarded upstream', () => {
    it('strips the caller cookie, Authorization and DorkOS agent token', async () => {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler({ ...DEFAULT_CONFIG, authHeader: 'X-Api-Key' });
      await handler(
        makeReq({
          headers: {
            'content-type': 'application/json',
            cookie: 'dorkos.session_token=secret-session',
            authorization: 'Bearer dorkos-api-key',
            'x-dorkos-agent': 'agent-token',
            'x-custom': 'keep-me',
          } as Record<string, string>,
        }),
        makeRes()
      );

      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(callHeaders).not.toHaveProperty('cookie');
      expect(callHeaders).not.toHaveProperty('authorization');
      expect(callHeaders).not.toHaveProperty('x-dorkos-agent');
      expect(callHeaders).toHaveProperty('x-custom', 'keep-me');
      expect(callHeaders).toHaveProperty('X-Api-Key', 'Bearer tok');
    });

    // The list holds a hardcoded copy of the agent-identity header name. If
    // that constant is ever renamed, this fails instead of the proxy quietly
    // resuming the leak.
    it('strips the real AGENT_IDENTITY_HEADER, not a copy that can drift', () => {
      expect(STRIPPED_HEADERS.has(AGENT_IDENTITY_HEADER)).toBe(true);
    });

    // A copy too, for the same reason: with a cookie from anywhere, the
    // person proof would let the upstream act as the person (DOR-3330).
    it('strips the real person proof header', () => {
      expect(STRIPPED_HEADERS.has(PERSON_PROOF_HEADER)).toBe(true);
    });

    it('leaves only the injected credential when the upstream header is Authorization', async () => {
      mockSecretGet.mockResolvedValue('upstream-token');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });

      const handler = getProxyHandler();
      await handler(
        makeReq({
          headers: {
            'content-type': 'application/json',
            authorization: 'Bearer dorkos-api-key',
          } as Record<string, string>,
        }),
        makeRes()
      );

      // Both spellings would survive into the same `Headers` object and be
      // joined with a comma, handing the upstream the caller's DorkOS key too.
      const callHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
      expect(Object.keys(callHeaders).filter((k) => k.toLowerCase() === 'authorization')).toEqual([
        'Authorization',
      ]);
      expect(callHeaders.Authorization).toBe('Bearer upstream-token');
    });
  });

  // The caller controls the whole sub-path, and `fetch` normalizes dot segments
  // before it opens the connection — so an unchecked `..` reaches endpoints
  // above the configured base path, carrying the injected credential.
  describe('path confinement under the baseUrl prefix', () => {
    const SCOPED: DataProxyConfig = { ...DEFAULT_CONFIG, baseUrl: 'https://api.example.com/v1' };

    /** Mock a successful upstream so a call that gets through is visible. */
    function armFetch(): void {
      mockSecretGet.mockResolvedValue('tok');
      globalThis.fetch = vi.fn().mockResolvedValue({
        status: 200,
        headers: new Headers(),
        text: () => Promise.resolve('ok'),
      });
    }

    it('refuses a "../" escape without calling the upstream', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['..', 'admin'] } }), res);

      expect(res._status).toBe(400);
      expect((res._body as { code: string }).code).toBe('outside_boundary');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses an escape that arrived percent-encoded (%2f decoded into one segment)', async () => {
      armFetch();

      // Each path segment is decoded on its own, so `..%2f..%2fadmin` reaches the
      // handler as a single segment that already contains separators.
      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['../../admin'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses a query string smuggled through the path', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['issues?admin=1'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses a fragment smuggled through the path', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['issues#frag'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    // Sent down a raw socket rather than through supertest: superagent
    // normalizes `%2e%2e` in the path before it ever leaves the client, so
    // supertest cannot express this request. A raw client can. The URL's dot
    // segments (`%2e%2e` among them) are resolved before the route matches, so
    // this one names `/api/ext/admin`: it leaves the extension's mount and
    // never reaches its proxy.
    it('never forwards `%2e%2e` traversal driven through the real router', async () => {
      armFetch();

      const status = await rawGetStatus(
        proxyApp(SCOPED),
        '/api/ext/test-ext/proxy/%2e%2e/%2e%2e/admin'
      );

      expect(status).toBe(404);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses `..%2f` traversal driven through the real router', async () => {
      armFetch();

      const res = await request(fixtureTarget.mount(proxyApp(SCOPED))).get(
        '/api/ext/test-ext/proxy/..%2f..%2fadmin'
      );

      expect(res.status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('refuses a climb whose landing segment reads like another host', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['..', '..', '@evil.example.com', 'x'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    // The companion fact: a caller cannot move the AUTHORITY at all, whatever
    // it writes, because the sub-path is appended to a fixed base. This one
    // stays on the manifest host and so is allowed — the test exists to pin
    // that the host really is unreachable rather than merely refused.
    it('keeps a `//host`-shaped path on the manifest origin instead of hopping to it', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      await handler(makeReq({ params: { splat: ['', 'evil.example.com', 'x'] } }), makeRes());

      const called = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(new URL(called).origin).toBe('https://api.example.com');
    });

    // A prefix compare that forgets the separator lets `/v1` admit `/v1evil`,
    // which is a different resource tree on the same host.
    it('refuses a sibling path that merely starts with the base prefix', async () => {
      armFetch();

      const handler = getProxyHandler(SCOPED);
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['..', 'v1evil', 'secrets'] } }), res);

      expect(res._status).toBe(400);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    // The two checks are not redundant: the first runs on the NORMALIZED URL,
    // the rewrite runs on the RAW string, so a caller path that cancels itself
    // out passes the first check and is un-cancelled by an ordinary
    // prefix-stripping rule.
    it('re-checks after pathRewrite, which can push a validated path back out', async () => {
      armFetch();

      const handler = getProxyHandler({ ...SCOPED, pathRewrite: { '/v1/legacy/': '/v1/' } });
      const res = makeRes();
      await handler(makeReq({ params: { splat: ['legacy', '..', 'admin'] } }), res);

      expect(res._status).toBe(400);
      expect((res._body as { code: string }).code).toBe('outside_boundary');
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});
