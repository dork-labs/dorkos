import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import type { ConnectorRuntimeTools } from '../../services/runtimes/connector-tools.js';
import {
  CONNECTOR_RUNTIME_CWD_HEADER,
  CONNECTOR_RUNTIME_KIND_HEADER,
} from '../../services/runtimes/connector-tools.js';
import { startComputerMcpBridge, type ComputerMcpBridge } from '../computer-mcp-bridge.js';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('address');
  return address.port;
}
function tools(port: number): ConnectorRuntimeTools {
  return {
    listenerUrl: `http://127.0.0.1:${port}/mcp`,
    agentToolsUrl: `http://127.0.0.1:${port}/agent-mcp`,
  } as ConnectorRuntimeTools;
}
const headers = {
  authorization: 'Bearer turn-only-secret',
  [CONNECTOR_RUNTIME_KIND_HEADER]: 'computer-local',
  [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/owned/anchor'),
  'X-DorkOS-Computer-Generation': '1',
  'content-type': 'application/json',
};
async function bridge(): Promise<{ bridge: ComputerMcpBridge; disable(): void; rotate(): void }> {
  let enabled = true;
  let generation = 1;
  const bridge = await startComputerMcpBridge({
    anchor: '/owned/anchor',
    acceptingWork: () => enabled,
    currentGeneration: () => generation,
  });
  cleanup.push(() => bridge.close());
  return {
    bridge,
    disable: () => {
      enabled = false;
    },
    rotate: () => {
      generation++;
    },
  };
}
describe('computer MCP bridge', () => {
  it('preserves exact turn authority to a fixed loopback target', async () => {
    let calls = 0;
    const server = createServer((req, res) => {
      calls++;
      expect(req.url).toBe('/agent-mcp');
      expect(req.headers.authorization).toBe('Bearer turn-only-secret');
      expect(req.headers[CONNECTOR_RUNTIME_KIND_HEADER.toLowerCase()]).toBe('computer-local');
      expect(req.headers[CONNECTOR_RUNTIME_CWD_HEADER.toLowerCase()]).toBe(
        encodeURIComponent('/owned/anchor')
      );
      res.setHeader('content-type', 'application/json');
      res.end('{"ok":true}');
    });
    const port = await listen(server);
    const { bridge: b, disable, rotate } = await bridge();
    b.configure(tools(port));
    expect(b.mapUrl(`http://127.0.0.1:${port}/agent-mcp`)).toBe(
      `http://host.lima.internal:${b.port}/agent-mcp`
    );
    const post = (path: string, extra = {}) =>
      fetch(`http://127.0.0.1:${b.port}${path}`, {
        method: 'POST',
        headers: { ...headers, ...extra },
        body: '{}',
      });
    expect(await (await post('/agent-mcp')).json()).toEqual({ ok: true });
    expect((await post('/agent-mcp', { [CONNECTOR_RUNTIME_KIND_HEADER]: 'opencode' })).status).toBe(
      403
    );
    expect(
      (await post('/agent-mcp', { [CONNECTOR_RUNTIME_CWD_HEADER]: encodeURIComponent('/foreign') }))
        .status
    ).toBe(403);
    expect((await post('/agent-mcp?url=http://elsewhere')).status).toBe(403);
    rotate();
    expect((await post('/agent-mcp')).status).toBe(403);
    disable();
    expect((await post('/agent-mcp', { 'X-DorkOS-Computer-Generation': '2' })).status).toBe(403);
    expect(calls).toBe(1);
  });
  it('refuses arbitrary target addresses and target redirects', async () => {
    const { bridge: b } = await bridge();
    expect(() =>
      b.configure({ ...tools(1), agentToolsUrl: 'http://192.168.1.2/agent-mcp' })
    ).toThrow('TARGET_REFUSED');
    const server = createServer((_req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:9/agent-mcp' });
      res.end();
    });
    b.configure(tools(await listen(server)));
    expect(
      (await fetch(`http://127.0.0.1:${b.port}/agent-mcp`, { method: 'POST', headers, body: '{}' }))
        .status
    ).toBe(502);
  });
});
