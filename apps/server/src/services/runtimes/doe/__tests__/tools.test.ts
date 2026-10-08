/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
vi.mock('../../shared/agent-context.js', () => ({
  buildAgentContextAppend: async () => ({ text: 'fresh identity memory', stable: '', memory: '' }),
}));
import { assembleDoeHost } from '../tools.js';
describe('Doe business host', () => {
  it('exposes read/skills/web/builder but no business shell and keeps routing out of context', async () => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'doe-host-')));
    try {
      const cwd = path.join(root, 'desk'),
        extra = path.join(root, 'extra');
      await mkdir(cwd);
      await mkdir(extra);
      const first = await assembleDoeHost({
        sessionId: 'session',
        cwd,
        signal: new AbortController().signal,
        opts: {
          additionalDirectories: [{ path: extra, access: 'read' }],
          roomTurn: { roomId: 'opaque-room', memberId: 'opaque-member', agentId: 'opaque-agent' },
        } as never,
      });
      const names = first.registry.selected().map((tool) => tool.name);
      expect(names).toContain('builder');
      expect(names).toContain('load_skill');
      expect(names).not.toContain('shell');
      const context = await first.resources.load();
      expect(context).toContain('fresh identity memory');
      expect(context).not.toContain('opaque-room');
      expect(first.pathPolicy.readRoots).toContain(extra);
      await first.dispose();
      const second = await assembleDoeHost({
        sessionId: 'session',
        cwd,
        signal: new AbortController().signal,
      });
      expect(second.pathPolicy.readRoots).not.toContain(extra);
      await second.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry, defineCapability } from '../../../core/capabilities/index.js';
import { createServerPrincipal } from '../../../connectors/principal/server-principal.js';
import { createAgentRuntimeMcpServer } from '../../connector-mcp/agent-runtime-server.js';
import { startConnectorRuntimeMcpListener } from '../../connector-mcp/listener.js';
import { assembleDoeMcp } from '../mcp.js';
import type { CapabilityInvocationContext } from '../../../core/capabilities/index.js';
import type { ConnectorRuntimePrincipalPort } from '../../../connectors/runtime-principal-port.js';

it('RT-MCP-01: executes registry projections through the real authenticated listener and preserves caller authority', async () => {
  const principal = createServerPrincipal({
    kind: 'runtime',
    owner: { kind: 'local_install', installationId: 'install' },
    bindingId: 'binding',
    runtime: 'doe',
    canonicalSessionId: 'session',
    agentId: 'agent',
    agentPath: '/agent',
    canonicalCwd: '/desk',
  });
  let seen: CapabilityInvocationContext | undefined;
  let hold: (() => Promise<void>) | undefined;
  const registry = composeRegistry(
    [
      {
        name: 'probe',
        capabilities: [
          defineCapability({
            id: 'probe.read',
            title: 'Read probe',
            description: 'Read harmless probe',
            tier: 'observe',
            area: null,
            input: z.object({}),
            output: z.object({ ok: z.boolean() }),
            surfaces: { mcp: { toolName: 'read_probe', servers: ['in-session'] } },
            invoke: async (_deps, _input, context) => {
              seen = context;
              await hold?.();
              return { ok: true };
            },
          }),
        ],
      },
    ],
    { logger: noopLogger }
  );
  let revoked = false;
  const resolve = vi.fn(async (input) =>
    input.bearer === 'test-turn' &&
    input.expectedRuntime === 'doe' &&
    input.expectedCanonicalCwd === '/desk' &&
    !revoked
      ? { status: 'resolved' as const, principal }
      : { status: 'refused' as const, reason: 'invalid' as const }
  );
  const principals = {
    resolve,
    openTurn: vi.fn(),
    renew: vi.fn(),
    revoke: vi.fn(),
  } satisfies ConnectorRuntimePrincipalPort;
  const listener = await startConnectorRuntimeMcpListener({
    principals,
    serverFactory: () => {
      const server = new McpServer({ name: 'connections', version: '1.0.0' });
      server.registerTool(
        'connectors.list_granted_connections',
        { description: 'Private connector probe' },
        async () => ({ content: [{ type: 'text', text: '{}' }] })
      );
      return server;
    },
    agentServerFactory: (proof) =>
      createAgentRuntimeMcpServer(registry, proof, {
        agentPath: '/agent',
        displayName: 'Agent',
        createdAt: '2026-10-08T00:00:00.000Z',
      }),
  });
  const injection = {
    url: listener.url,
    agentToolsUrl: listener.agentUrl,
    headers: {
      Authorization: 'Bearer test-turn',
      'X-DorkOS-Connector-Runtime': 'doe',
      'X-DorkOS-Connector-Cwd': encodeURIComponent('/desk'),
    },
  };
  const turnAbort = new AbortController();
  let mcp: Awaited<ReturnType<typeof assembleDoeMcp>> | undefined;
  try {
    mcp = await assembleDoeMcp({
      agentPath: '/agent',
      connectorInjection: injection,
      signal: turnAbort.signal,
    });
    const tool = mcp.tools.find((item) => item.name === 'read_probe')!;
    const context = {
      sessionId: 'spoof-session',
      scope: 'main' as const,
      workingDirectory: '/spoof',
      signal: new AbortController().signal,
      emit: () => {},
    };
    expect((await tool.execute({}, context)).isError).toBe(false);
    expect(seen).toMatchObject({
      sessionId: 'session',
      cwd: '/agent',
      serverPrincipal: principal,
      identity: { agentPath: '/agent' },
    });
    expect(resolve).toHaveBeenCalledWith({
      bearer: 'test-turn',
      expectedRuntime: 'doe',
      expectedCanonicalCwd: '/desk',
    });
    revoked = true;
    expect((await tool.execute({}, context)).isError).toBe(true);
    revoked = false;
    // Approval holds belong to this authenticated turn, not a foreign server's short deadline.
    let started!: () => void;
    const entered = new Promise<void>((resolve) => {
      started = resolve;
    });
    hold = () =>
      new Promise<void>(() => {
        started();
      });
    const abortHeld = new AbortController();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const held = tool.execute({}, { ...context, signal: abortHeld.signal });
    const cancelled = expect(held).resolves.toMatchObject({ isError: true });
    await entered;
    let settled = false;
    void held.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await vi.advanceTimersByTimeAsync(10001);
    expect(settled).toBe(false);
    turnAbort.abort();
    await cancelled;
    vi.useRealTimers();
    hold = undefined;
  } finally {
    vi.useRealTimers();
    await mcp?.dispose();
    await listener.close();
  }
});

import express from 'express';
import { createServer } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { mcpAlias } from '@dorkos/doe';
it('RT-MCP-02: bridges legacy managed SSE with explicit headers, deferred foreign aliases and owned shutdown', async () => {
  const app = express();
  app.use(express.json());
  const sessions = new Map<string, SSEServerTransport>(),
    servers: McpServer[] = [],
    headers: string[] = [];
  app.get('/sse', async (req, res) => {
    headers.push(req.header('authorization') ?? '');
    const transport = new SSEServerTransport('/messages', res);
    sessions.set(transport.sessionId, transport);
    const server = new McpServer({ name: 'legacy-managed', version: '1.0.0' });
    servers.push(server);
    server.registerTool(
      'post_to_room',
      { description: 'Foreign room-named tool', inputSchema: { value: z.string() } },
      async ({ value }) => ({ content: [{ type: 'text', text: value }] })
    );
    server.registerTool(
      'hanging',
      { description: 'Cancellable hanging tool' },
      async () => new Promise<never>(() => {})
    );
    await server.connect(transport);
  });
  app.post('/messages', async (req, res) => {
    headers.push(req.header('authorization') ?? '');
    const transport = sessions.get(String(req.query.sessionId));
    if (!transport) {
      res.sendStatus(404);
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });
  const http = createServer(app);
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  let mcp: Awaited<ReturnType<typeof assembleDoeMcp>> | undefined;
  try {
    mcp = await assembleDoeMcp({
      servers: {
        legacy: {
          transport: 'sse',
          url: `http://127.0.0.1:${port}/sse`,
          headers: { Authorization: 'Bearer explicit-managed' },
        },
      },
      signal: new AbortController().signal,
    });
    const name = mcpAlias('managed:legacy', 'post_to_room'),
      tool = mcp.tools.find((item) => item.name === name)!;
    expect(tool.initialLoad).toBeUndefined();
    expect(mcp.trustedHostToolNames.has(name)).toBe(false);
    expect(
      await tool.execute(
        { value: 'SSE result' },
        {
          sessionId: 'session',
          scope: 'main',
          workingDirectory: '/desk',
          signal: new AbortController().signal,
          emit: () => {},
        }
      )
    ).toMatchObject({ content: [{ type: 'text', text: 'SSE result' }], isError: false });
    expect(headers.length).toBeGreaterThan(3);
    expect(new Set(headers)).toEqual(new Set(['Bearer explicit-managed']));
    expect(mcp.statuses).toEqual([
      { name: 'legacy', type: 'sse', scope: 'managed', status: 'connected' },
    ]);
    const abortCall = new AbortController();
    const timer = setTimeout(() => abortCall.abort(), 20);
    try {
      expect(
        (
          await mcp.tools
            .find((item) => item.name === mcpAlias('managed:legacy', 'hanging'))!
            .execute(
              {},
              {
                sessionId: 'session',
                scope: 'main',
                workingDirectory: '/desk',
                signal: abortCall.signal,
                emit: () => {},
              }
            )
        ).isError
      ).toBe(true);
    } finally {
      clearTimeout(timer);
    }
    await mcp.dispose();
    expect(mcp.statuses[0]?.status).toBe('pending');
  } finally {
    await mcp?.dispose();
    await Promise.all(servers.map((server) => server.close()));
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});

it('cancels legacy SSE setup before the server publishes its POST endpoint', async () => {
  const http = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': waiting\n\n');
  });
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const port = (http.address() as { port: number }).port;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 20);
  try {
    await expect(
      assembleDoeMcp({
        servers: { stalled: { transport: 'sse', url: `http://127.0.0.1:${port}/sse` } },
        signal: abort.signal,
      })
    ).rejects.toThrow();
  } finally {
    clearTimeout(timer);
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
});
