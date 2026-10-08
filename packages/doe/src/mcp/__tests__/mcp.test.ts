import { afterEach, expect, it, vi } from 'vitest';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { McpConnection } from '../connection.js';
import { DeferredToolRegistry } from '../../registry/registry.js';
import type { ToolContext } from '../../contracts.js';
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
const context: ToolContext = {
  sessionId: 'a',
  scope: 'main',
  workingDirectory: '.',
  signal: new AbortController().signal,
  emit: () => {},
};
async function httpFixture(mode = 'normal') {
  const seen: string[] = [];
  const s = createServer(async (req, res) => {
    let data = '';
    for await (const x of req) data += x;
    if (req.method === 'DELETE') {
      seen.push('DELETE');
      res.end();
      return;
    }
    const m = JSON.parse(data);
    seen.push(m.method);
    if (mode === 'redirect') {
      res.writeHead(302, { location: 'http://localhost:1/leak' });
      res.end();
      return;
    }
    if (mode === 'oversize') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('x'.repeat(3000));
      return;
    }
    if (mode === 'connect_hang' && m.method === 'initialize') return;
    if (!('id' in m)) {
      res.writeHead(202);
      res.end();
      return;
    }
    let result: unknown;
    if (m.method === 'initialize') {
      res.setHeader('mcp-session-id', 'fixture');
      result = {
        protocolVersion: m.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fixture', version: '1' },
      };
    }
    if (m.method === 'tools/list')
      result = m.params?.cursor
        ? {
            tools: [{ name: 'second', inputSchema: { type: 'object' } }],
            ...(mode === 'cursor' ? { nextCursor: 'two' } : {}),
          }
        : {
            tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object' } }],
            nextCursor: 'two',
          };
    if (m.method === 'tools/call') {
      if (m.params.arguments.mode === 'hang') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress', params: { progressToken: m.params._meta.progressToken, progress: 1, message: 'started' } })}\n\n`
        );
        return;
      }
      result = {
        content: [
          { type: 'text', text: 'hello' },
          { type: 'image', data: 'YWJj', mimeType: 'image/png' },
        ],
        structuredContent: { ok: true },
        isError: m.params.arguments.mode === 'tool_error',
      };
      if (m.params.arguments.mode === 'error') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: m.id,
            error: { code: -32603, message: 'fixture error' },
          })
        );
        return;
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(
        m.method === 'tools/call' && m.params._meta?.progressToken !== undefined
          ? [
              {
                jsonrpc: '2.0',
                method: 'notifications/progress',
                params: {
                  progressToken: m.params._meta.progressToken,
                  progress: 1,
                  total: 2,
                  message: 'working',
                },
              },
              { jsonrpc: '2.0', id: m.id, result },
            ]
          : { jsonrpc: '2.0', id: m.id, result }
      )
    );
  });
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        s.closeAllConnections();
        s.close(() => resolve());
      })
  );
  return { url: `http://127.0.0.1:${(s.address() as { port: number }).port}/mcp`, seen, s };
}
for (const transport of ['stdio', 'http'] as const)
  it(`${transport} actual client supports healthy pages, exact results, errors and close`, async () => {
    const cfg =
      transport === 'stdio'
        ? {
            kind: 'stdio' as const,
            command: process.execPath,
            args: [join(import.meta.dirname, 'server.mjs')],
            environment: { ALLOWED: 'yes' },
          }
        : {
            kind: 'http' as const,
            url: (await httpFixture()).url,
            headers: { 'x-explicit': 'yes' },
          };
    const c = new McpConnection('fixture', cfg, { callTimeoutMs: 5000, connectTimeoutMs: 5000 });
    cleanups.push(() => c.close());
    await c.connect();
    const r = new DeferredToolRegistry();
    const aliases = await c.registerTools(r);
    expect(aliases).toHaveLength(2);
    r.search('echo', 1);
    const progress = vi.fn();
    const result = await r.execute(
      aliases[0]!,
      {},
      { ...context, callId: 'pi-call-id', emit: progress }
    );
    expect(progress).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'tool-progress',
        name: aliases[0],
        callId: 'pi-call-id',
        progress: 'working',
      })
    );
    expect(result).toEqual({
      content: [
        { type: 'text', text: 'hello' },
        { type: 'image', data: 'YWJj', mimeType: 'image/png' },
      ],
      structuredContent: { ok: true },
      isError: false,
    });
    expect((await c.call('echo', { mode: 'tool_error' }, context.signal)).isError).toBe(true);
    expect((await c.call('echo', { mode: 'error' }, context.signal)).isError).toBe(true);
    await c.close();
    await c.close();
    expect((await c.call('echo', {}, context.signal)).isError).toBe(true);
  });
it('stdio environment is explicit and connect abort/deadline settle', async () => {
  vi.stubEnv('ANTHROPIC_API_KEY', 'sentinel');
  vi.stubEnv('CLOUD_SECRET', 'sentinel');
  const cfg = {
    kind: 'stdio' as const,
    command: process.execPath,
    args: [join(import.meta.dirname, 'server.mjs')],
    environment: { ALLOWED: 'yes' },
  };
  const c = new McpConnection('env', cfg);
  cleanups.push(() => c.close());
  await c.connect();
  const result = await c.call('env', {}, context.signal);
  const env = JSON.parse((result.content[0] as { text: string }).text);
  expect(env.ALLOWED).toBe('yes');
  expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  expect(env.CLOUD_SECRET).toBeUndefined();
  const h = new McpConnection(
    'hang',
    { ...cfg, environment: { MODE: 'connect_hang' } },
    { connectTimeoutMs: 40 }
  );
  cleanups.push(() => h.close());
  await expect(h.connect()).rejects.toThrow();
  const a = new McpConnection('abort', { ...cfg, environment: { MODE: 'connect_hang' } });
  cleanups.push(() => a.close());
  const signal = new AbortController();
  const p = a.connect(signal.signal);
  signal.abort();
  await expect(p).rejects.toThrow();
});
it('HTTP rejects oversized bodies, redirects and repeated cursors without implicit requests', async () => {
  for (const mode of ['oversize', 'redirect', 'connect_hang']) {
    const { url } = await httpFixture(mode);
    const c = new McpConnection(
      mode,
      { kind: 'http', url },
      { maxMessageBytes: 1024, connectTimeoutMs: 40 }
    );
    cleanups.push(() => c.close());
    await expect(c.connect()).rejects.toThrow();
  }
  const { url } = await httpFixture('cursor');
  const c = new McpConnection('cursor', { kind: 'http', url });
  cleanups.push(() => c.close());
  await c.connect();
  await expect(c.registerTools(new DeferredToolRegistry())).rejects.toThrow('cursor');
  const fetch = vi.spyOn(globalThis, 'fetch');
  new McpConnection('offline', { kind: 'http', url: 'http://localhost:1' });
  expect(fetch).not.toHaveBeenCalled();
});
it('bounded fetch caps JSON, HTTP errors and SSE and never follows redirects', async () => {
  const { boundedMcpFetch } = await import('../connection.js');
  for (const [status, type] of [
    [200, 'application/json'],
    [500, 'text/plain'],
    [200, 'text/event-stream'],
  ] as const) {
    let cancelled = false;
    const f = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(c) {
              c.enqueue(new TextEncoder().encode('x'.repeat(100)));
            },
            cancel() {
              cancelled = true;
            },
          }),
          { status, headers: { 'content-type': type } }
        )
    );
    const response = await boundedMcpFetch('http://localhost/mcp', 32, f)('http://localhost/mcp');
    await expect(response.text()).rejects.toThrow('byte limit');
    expect(cancelled).toBe(true);
    expect(f.mock.calls).toHaveLength(1);
  }
  const f = vi.fn(
    async () => new Response(null, { status: 302, headers: { location: 'http://outsider/leak' } })
  );
  await expect(
    boundedMcpFetch(
      'http://localhost/mcp',
      32,
      f
    )('http://localhost/mcp', { headers: { Authorization: 'secret' } })
  ).rejects.toThrow('redirects');
  expect(f).toHaveBeenCalledExactlyOnceWith(
    'http://localhost/mcp',
    expect.objectContaining({ redirect: 'manual' })
  );
});
it('discovery caps pages, items and bytes before registering any tools', async () => {
  for (const limits of [{ maxPages: 1 }, { maxTools: 1 }, { maxDiscoveryBytes: 10 }]) {
    const { url } = await httpFixture();
    const c = new McpConnection('bounded', { kind: 'http', url }, limits);
    cleanups.push(() => c.close());
    await c.connect();
    const r = new DeferredToolRegistry();
    await expect(c.registerTools(r)).rejects.toThrow('limit');
    expect(r.inventory().items).toEqual([]);
  }
});
it('HTTP connect abort rejects and closes its actual configured session', async () => {
  const { url } = await httpFixture('connect_hang');
  const c = new McpConnection('abort', { kind: 'http', url });
  cleanups.push(() => c.close());
  const controller = new AbortController();
  const pending = c.connect(controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow('aborted');
});
for (const reason of ['abort', 'deadline'])
  it(`HTTP ${reason} closes the actual outstanding response before settling`, async () => {
    let responseClosed = false;
    let received!: () => void;
    const started = new Promise<void>((resolve) => {
      received = resolve;
    });
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const x of req) body += x;
      if (req.method === 'DELETE') {
        res.end();
        return;
      }
      const m = JSON.parse(body);
      if (!('id' in m)) {
        res.writeHead(202);
        res.end();
        return;
      }
      if (m.method === 'tools/call') {
        res.on('close', () => {
          responseClosed = true;
        });
        received();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: m.id,
          result: {
            protocolVersion: m.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: 'fixture', version: '1' },
          },
        })
      );
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    cleanups.push(
      () =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        })
    );
    const c = new McpConnection(
      'owned',
      { kind: 'http', url: `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp` },
      { callTimeoutMs: 100 }
    );
    cleanups.push(() => c.close());
    await c.connect();
    const controller = new AbortController();
    const call = c.call('hang', {}, controller.signal);
    await started;
    if (reason === 'abort') controller.abort();
    expect((await call).isError).toBe(true);
    await vi.waitFor(() => expect(responseClosed).toBe(true), { timeout: 500 });
  });

for (const transport of ['stdio', 'http'] as const)
  for (const reason of ['abort', 'deadline'] as const)
    it(`${transport} fresh call ${reason} is exercised after request progress`, async () => {
      const cfg =
        transport === 'stdio'
          ? {
              kind: 'stdio' as const,
              command: process.execPath,
              args: [join(import.meta.dirname, 'server.mjs')],
              environment: {},
            }
          : { kind: 'http' as const, url: (await httpFixture()).url };
      const c = new McpConnection('fresh', cfg, {
        callTimeoutMs: reason === 'deadline' ? 1500 : 5000,
        connectTimeoutMs: 5000,
      });
      cleanups.push(() => c.close());
      await c.connect();
      const controller = new AbortController();
      let started!: () => void;
      const progress = new Promise<void>((resolve) => {
        started = resolve;
      });
      const pending = c.call('echo', { mode: 'hang' }, controller.signal, () => started());
      await progress;
      if (reason === 'abort') controller.abort();
      expect((await pending).isError).toBe(true);
      expect((await c.call('echo', {}, context.signal)).isError).toBe(true);
    });
