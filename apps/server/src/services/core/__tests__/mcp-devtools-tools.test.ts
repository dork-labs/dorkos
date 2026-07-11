import { describe, it, expect, vi } from 'vitest';
import type { DevtoolsConsoleEntry, DevtoolsNetworkEntry } from '@dorkos/shared/schemas';
import {
  createReadConsoleHandler,
  createReadNetworkHandler,
  getDevtoolsTools,
} from '../../runtimes/claude-code/mcp-tools/devtools-tools.js';
import type { McpToolDeps } from '../../runtimes/claude-code/mcp-tools/types.js';
import { DevtoolsCaptureStore } from '../../session/devtools-capture-store.js';

// Passthrough mock so getDevtoolsTools() can build tool defs without the real
// SDK: the registered handler is exposed directly for invocation.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  tool: (
    name: string,
    description: string,
    schema: Record<string, unknown>,
    handler: (...args: unknown[]) => unknown
  ) => ({ name, description, schema, handler }),
}));

/** Shape of the passthrough tool def the mocked `tool()` returns. */
interface MockTool {
  name: string;
  handler: (
    input: Record<string, unknown>
  ) => Promise<{ content: { text: string }[]; isError?: boolean }>;
}

const SESSION_ID = 'sess-1';

function parse(result: { content: { text: string }[] }): Record<string, unknown> {
  return JSON.parse(result.content[0].text);
}

function consoleEntry(over: Partial<DevtoolsConsoleEntry> = {}): DevtoolsConsoleEntry {
  return { level: 'log', text: 'hello', timestamp: 1, ...over };
}

function networkEntry(over: Partial<DevtoolsNetworkEntry> = {}): DevtoolsNetworkEntry {
  return {
    method: 'GET',
    url: 'http://localhost:3000/api',
    status: 200,
    ok: true,
    durationMs: 12,
    timestamp: 1,
    ...over,
  };
}

/** A store seeded with one ingest batch for SESSION_ID. */
function seededStore(
  consoleEntries: DevtoolsConsoleEntry[],
  networkEntries: DevtoolsNetworkEntry[] = []
): DevtoolsCaptureStore {
  const store = new DevtoolsCaptureStore();
  store.ingest(SESSION_ID, {
    seq: 1,
    logicalUrl: 'http://localhost:3000/',
    documentId: 'doc-1',
    console: consoleEntries,
    network: networkEntries,
  });
  return store;
}

describe('browser_read_console handler', () => {
  it('returns captured console entries with the document header', async () => {
    const store = seededStore([
      consoleEntry({ level: 'error', text: 'boom', stack: 'at App.tsx:42', timestamp: 10 }),
    ]);
    const result = parse(await createReadConsoleHandler(SESSION_ID, store)({}));

    expect(result.documentUrl).toBe('http://localhost:3000/');
    expect(typeof result.capturedAt).toBe('number');
    expect(result.entries).toHaveLength(1);
    expect((result.entries as DevtoolsConsoleEntry[])[0]).toMatchObject({
      level: 'error',
      text: 'boom',
      stack: 'at App.tsx:42',
    });
    expect(result.truncated).toBe(false);
    expect(result.note).toBeUndefined();
  });

  it('filters by level', async () => {
    const store = seededStore([
      consoleEntry({ level: 'log', text: 'a', timestamp: 1 }),
      consoleEntry({ level: 'error', text: 'b', timestamp: 2 }),
      consoleEntry({ level: 'warn', text: 'c', timestamp: 3 }),
    ]);
    const result = parse(await createReadConsoleHandler(SESSION_ID, store)({ level: 'error' }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('b');
  });

  it('honors limit, returns the newest entries, and flags truncated', async () => {
    const store = seededStore(
      Array.from({ length: 10 }, (_, i) => consoleEntry({ text: `line-${i}`, timestamp: i }))
    );
    const result = parse(await createReadConsoleHandler(SESSION_ID, store)({ limit: 3 }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries.map((e) => e.text)).toEqual(['line-7', 'line-8', 'line-9']);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/most recent of 10/i);
  });

  it('flags truncated when the server ring is at capacity', async () => {
    const store = seededStore(
      Array.from({ length: 500 }, (_, i) => consoleEntry({ text: `l${i}`, timestamp: i }))
    );
    const result = parse(await createReadConsoleHandler(SESSION_ID, store)({ limit: 500 }));

    expect((result.entries as DevtoolsConsoleEntry[]).length).toBe(500);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/buffer is full/i);
  });

  it('returns the no-preview note when the session never captured anything', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadConsoleHandler(SESSION_ID, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.note).toMatch(/browser_navigate/i);
    expect(result.documentUrl).toBeUndefined();
  });

  it('returns a connected-but-silent note when the console ring is empty', async () => {
    const store = seededStore([], [networkEntry()]);
    const result = parse(await createReadConsoleHandler(SESSION_ID, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/connected but has logged nothing/i);
    expect(result.documentUrl).toBe('http://localhost:3000/');
  });
});

describe('browser_read_network handler', () => {
  it('returns captured requests with method/url/status/duration/size', async () => {
    const store = seededStore(
      [],
      [networkEntry({ status: 404, ok: false, responseSize: 128, timestamp: 5 })]
    );
    const result = parse(await createReadNetworkHandler(SESSION_ID, store)({}));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      method: 'GET',
      status: 404,
      ok: false,
      durationMs: 12,
      responseSize: 128,
    });
  });

  it('filters by "failed" status', async () => {
    const store = seededStore(
      [],
      [
        networkEntry({ status: 200, ok: true, timestamp: 1 }),
        networkEntry({ status: 500, ok: false, timestamp: 2 }),
      ]
    );
    const result = parse(await createReadNetworkHandler(SESSION_ID, store)({ status: 'failed' }));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe(500);
  });

  it('filters by status class', async () => {
    const store = seededStore(
      [],
      [
        networkEntry({ status: 201, ok: true, timestamp: 1 }),
        networkEntry({ status: 404, ok: false, timestamp: 2 }),
        networkEntry({ status: 502, ok: false, timestamp: 3 }),
      ]
    );
    const result = parse(await createReadNetworkHandler(SESSION_ID, store)({ status: '4xx' }));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests).toHaveLength(1);
    expect(requests[0].status).toBe(404);
  });

  it('honors limit and flags truncated', async () => {
    const store = seededStore(
      [],
      Array.from({ length: 6 }, (_, i) =>
        networkEntry({ url: `http://localhost/${i}`, timestamp: i })
      )
    );
    const result = parse(await createReadNetworkHandler(SESSION_ID, store)({ limit: 2 }));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests.map((r) => r.url)).toEqual(['http://localhost/4', 'http://localhost/5']);
    expect(result.truncated).toBe(true);
  });

  it('returns the no-preview note when nothing captured', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadNetworkHandler(SESSION_ID, store)({}));

    expect(result.requests).toEqual([]);
    expect(result.note).toMatch(/browser_navigate/i);
  });
});

describe('getDevtoolsTools registration', () => {
  const emptyDeps = {} as McpToolDeps;

  function toolsFor(sessionId?: string): MockTool[] {
    return getDevtoolsTools(
      emptyDeps,
      sessionId,
      new DevtoolsCaptureStore()
    ) as unknown as MockTool[];
  }

  it('registers exactly browser_read_console and browser_read_network', () => {
    expect(toolsFor(SESSION_ID).map((t) => t.name)).toEqual([
      'browser_read_console',
      'browser_read_network',
    ]);
  });

  it('returns a session-less error when no session is bound', async () => {
    const tools = toolsFor(undefined);
    for (const t of tools) {
      const result = await t.handler({});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/require an attached interactive session/i);
      expect(parsed.entries).toBeUndefined();
      expect(parsed.requests).toBeUndefined();
    }
  });

  it('reads the bound session buffer when a session is bound', async () => {
    const store = seededStore([consoleEntry({ text: 'live', timestamp: 1 })]);
    const [readConsole] = getDevtoolsTools(emptyDeps, SESSION_ID, store) as unknown as MockTool[];
    const parsed = JSON.parse((await readConsole.handler({})).content[0].text);
    expect((parsed.entries as DevtoolsConsoleEntry[])[0].text).toBe('live');
  });
});
