/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DeferredToolRegistry, mcpAlias, type ToolRegistry } from '@dorkos/doe';
const calls = vi.hoisted(() => ({
  transports: [] as unknown[],
  closes: 0,
  limits: [] as Array<{ callTimeoutMs: number }>,
  names: ['post_to_room', 'list_capabilities', 'memory_write'],
}));
vi.mock('@dorkos/doe', async (original) => {
  const actual = await original<typeof import('@dorkos/doe')>();
  return {
    ...actual,
    McpConnection: class {
      constructor(
        readonly id: string,
        config: unknown,
        limits: { callTimeoutMs: number }
      ) {
        calls.transports.push(config);
        calls.limits.push(limits);
      }
      async connect(signal: AbortSignal) {
        signal.throwIfAborted();
      }
      async close() {
        calls.closes++;
      }
      async registerTools(registry: ToolRegistry) {
        for (const name of calls.names)
          registry.register({
            name: actual.mcpAlias(this.id, name),
            description: `Perform ${name}`,
            searchHint: `${this.id} ${name}`,
            schema: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: this.id }] }),
          });
        return [];
      }
    },
  };
});
import { assembleDoeMcp } from '../mcp.js';
import { CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS } from '../../connector-tools.js';
const injection = {
  url: 'http://127.0.0.1:4444/private',
  agentToolsUrl: 'http://127.0.0.1:4444/agent',
  headers: {
    Authorization: 'Bearer test-turn',
    'X-DorkOS-Connector-Runtime': 'doe',
    'X-DorkOS-Connector-Cwd': '/agent',
  },
};
beforeEach(() => {
  calls.transports = [];
  calls.closes = 0;
  calls.limits = [];
  calls.names = ['post_to_room', 'list_capabilities', 'memory_write'];
});
describe('authenticated Doe MCP assembly', () => {
  it('preserves every turn authentication header and refuses a global fallback', async () => {
    const assembly = await assembleDoeMcp({
      agentPath: '/agent',
      connectorInjection: injection,
      signal: new AbortController().signal,
    });
    expect(calls.transports[0]).toEqual({
      kind: 'http',
      url: injection.agentToolsUrl,
      headers: injection.headers,
    });
    expect(assembly.tools.find((tool) => tool.name === 'post_to_room')?.initialLoad).toBe(true);
    await assembly.dispose();
    expect(calls.closes).toBe(2);
    const absent = await assembleDoeMcp({
      agentPath: '/agent',
      signal: new AbortController().signal,
    });
    expect(absent.hostConnected).toBe(false);
    expect(absent.tools).toEqual([]);
  });
  it('keeps identically named foreign tools hashed and deferred', async () => {
    const assembly = await assembleDoeMcp({
      agentPath: '/agent',
      connectorInjection: injection,
      servers: { dorkos: { transport: 'http', url: 'http://127.0.0.1:5555/mcp' } },
      signal: new AbortController().signal,
    });
    expect(
      assembly.tools.find((tool) => tool.name === mcpAlias('managed:dorkos', 'post_to_room'))
        ?.initialLoad
    ).toBeUndefined();
    expect(assembly.tools.filter((tool) => tool.name === 'post_to_room')).toHaveLength(1);
    expect(calls.limits.map((limit) => limit.callTimeoutMs)).toEqual([
      CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS,
      CONNECTOR_RUNTIME_TOOL_TIMEOUT_MS,
      10000,
    ]);
    await assembly.dispose();
  });
  // On any configured server, not only one shaped like the agent browser: a Playwright server
  // started through a wrapper script is covered too. `browser_evaluate` runs in the page and stays.
  it('never offers a browser tool that reaches past the page, in any case', async () => {
    calls.names = [
      'browser_snapshot',
      'browser_evaluate',
      'browser_run_code_unsafe',
      'Browser_Network_Request',
    ];
    const assembly = await assembleDoeMcp({
      agentPath: '/agent',
      servers: {
        browser: { transport: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@0.0.82'] },
        wrapped: { transport: 'stdio', command: 'node', args: ['start-browser.js'] },
      },
      signal: new AbortController().signal,
    });
    const names = assembly.tools.map((tool) => tool.name);
    for (const server of ['managed:browser', 'managed:wrapped']) {
      expect(names).toContain(mcpAlias(server, 'browser_snapshot'));
      expect(names).toContain(mcpAlias(server, 'browser_evaluate'));
      expect(names).not.toContain(mcpAlias(server, 'browser_run_code_unsafe'));
      expect(names).not.toContain(mcpAlias(server, 'Browser_Network_Request'));
    }
    expect(
      [...assembly.names.keys()].some((key) => /run_code_unsafe|network_request$/i.test(key))
    ).toBe(false);
    await assembly.dispose();
  });
  it('refuses a browser call that names a file, and runs it without one', async () => {
    calls.names = ['browser_take_screenshot', 'Browser_File_Upload'];
    const assembly = await assembleDoeMcp({
      agentPath: '/agent',
      servers: { pw: { transport: 'stdio', command: 'node', args: ['start-browser.js'] } },
      signal: new AbortController().signal,
    });
    const tool = (bare: string) =>
      assembly.tools.find((entry) => entry.name === mcpAlias('managed:pw', bare))!;
    const context = { signal: new AbortController().signal, emit: () => {} } as never;
    await expect(
      tool('browser_take_screenshot').execute({ filename: 'shot.png' }, context)
    ).rejects.toThrow("can't reach files");
    await expect(
      tool('Browser_File_Upload').execute({ paths: ['/home/me/.dork/x'] }, context)
    ).rejects.toThrow("can't reach files");
    for (const args of [
      { filename: '' },
      { filename: null },
      { Paths: [] },
      { options: { outputDir: '/tmp' } },
      { fields: [{ ref: 'e1' }, { path: '/x' }] },
      { url: 'file:///x' },
      { url: 'FILE://x' },
      { url: ' file:x' },
      { url: 'fi\tle:///x' },
      { url: '\u0001file:///x' },
      { url: 'VIEW-SOURCE:file:///x' },
      { fields: [{ ref: 'e1', value: 'file:///x' }] },
    ]) {
      await expect(tool('browser_take_screenshot').execute(args as never, context)).rejects.toThrow(
        "can't reach files"
      );
    }
    for (const args of [
      { fields: [{ ref: 'e1', value: 'a' }] },
      { url: 'https://example.com' },
      { text: 'see the file: notes.txt' },
    ]) {
      await expect(
        tool('browser_take_screenshot').execute(args as never, context)
      ).resolves.toEqual({
        content: [{ type: 'text', text: 'managed:pw' }],
      });
    }
    await expect(tool('browser_take_screenshot').execute({}, context)).resolves.toEqual({
      content: [{ type: 'text', text: 'managed:pw' }],
    });
    await assembly.dispose();
  });
  it('holds the eager schema budget constant as registry contributions grow', async () => {
    const measure = async () => {
      const assembly = await assembleDoeMcp({
        agentPath: '/agent',
        connectorInjection: injection,
        signal: new AbortController().signal,
      });
      const registry = new DeferredToolRegistry();
      assembly.tools.forEach((tool) => registry.register(tool));
      const bytes = JSON.stringify(registry.selected()).length;
      await assembly.dispose();
      return bytes;
    };
    const baseline = await measure();
    calls.names.push(...Array.from({ length: 3000 }, (_, index) => `future_capability_${index}`));
    expect(await measure()).toBe(baseline);
  });
});
