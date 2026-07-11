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
const resolveSession = () => SESSION_ID;

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

/** A store seeded with one ingest batch for `sessionId` (default SESSION_ID). */
function seededStore(
  consoleEntries: DevtoolsConsoleEntry[],
  networkEntries: DevtoolsNetworkEntry[] = [],
  sessionId = SESSION_ID
): DevtoolsCaptureStore {
  const store = new DevtoolsCaptureStore();
  store.ingest(sessionId, {
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
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

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
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ level: 'error' }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0].text).toBe('b');
  });

  it('honors limit, returns the newest entries, and flags truncated', async () => {
    const store = seededStore(
      Array.from({ length: 10 }, (_, i) => consoleEntry({ text: `line-${i}`, timestamp: i }))
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 3 }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries.map((e) => e.text)).toEqual(['line-7', 'line-8', 'line-9']);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/most recent of 10/i);
  });

  it('flags truncated when the server ring evicted by count cap', async () => {
    // 501 entries: the 500-cap ring drops the oldest and flags consoleEvicted.
    const store = seededStore(
      Array.from({ length: 501 }, (_, i) => consoleEntry({ text: `l${i}`, timestamp: i }))
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 500 }));

    expect((result.entries as DevtoolsConsoleEntry[]).length).toBeLessThanOrEqual(500);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/buffer overflowed/i);
  });

  it('flags truncated when the byte budget evicted below the count cap', async () => {
    // ~60 entries of ~20 KB each (~1.2 MB) blow the 1 MB session budget while
    // the ring count stays far below 500 — a count-only check would lie here.
    const store = seededStore(
      Array.from({ length: 60 }, (_, i) =>
        consoleEntry({ text: `${i}:${'x'.repeat(20_000)}`, timestamp: i })
      )
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 10 }));

    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/buffer overflowed/i);
  });

  it('elides oversized text/stack/args per entry with an explicit marker', async () => {
    const store = seededStore([
      consoleEntry({
        text: 'y'.repeat(10_000),
        stack: 's'.repeat(10_000),
        args: ['z'.repeat(10_000)],
        timestamp: 1,
      }),
    ]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    const entry = (result.entries as DevtoolsConsoleEntry[])[0];
    expect(entry.text.length).toBeLessThan(2_200);
    expect(entry.text).toMatch(/\[truncated \d+ chars\]/);
    expect(entry.stack!.length).toBeLessThan(2_200);
    expect(entry.stack).toMatch(/\[truncated \d+ chars\]/);
    expect(entry.args).toHaveLength(1);
    expect(String(entry.args![0])).toMatch(/\[args elided: \d+ chars/);
  });

  it('drops the oldest entries past the total result byte budget', async () => {
    // 50 entries of ~2 KB text survive elision untouched (~2 KB serialized each
    // ≈ 100 KB total), so the ~64 KB result budget must drop the oldest.
    const store = seededStore(
      Array.from({ length: 50 }, (_, i) =>
        consoleEntry({ text: `${i}:${'x'.repeat(2_000)}`, timestamp: i })
      )
    );
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ limit: 50 }));

    const entries = result.entries as DevtoolsConsoleEntry[];
    expect(entries.length).toBeLessThan(50);
    expect(entries.length).toBeGreaterThan(0);
    // Newest entry always survives.
    expect(entries[entries.length - 1].text.startsWith('49:')).toBe(true);
    expect(result.truncated).toBe(true);
    expect(result.note).toMatch(/size budget/i);
  });

  it('returns the no-preview note when the session never captured anything', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.note).toMatch(/browser_navigate/i);
    expect(result.documentUrl).toBeUndefined();
  });

  it('returns a connected-but-silent note when the console ring is empty', async () => {
    const store = seededStore([], [networkEntry()]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/connected but has logged nothing/i);
    expect(result.documentUrl).toBe('http://localhost:3000/');
  });

  it('says entries exist at other levels when the filter matches nothing', async () => {
    const store = seededStore([
      consoleEntry({ level: 'warn', text: 'w1', timestamp: 1 }),
      consoleEntry({ level: 'warn', text: 'w2', timestamp: 2 }),
    ]);
    const result = parse(await createReadConsoleHandler(resolveSession, store)({ level: 'error' }));

    expect(result.entries).toEqual([]);
    expect(result.note).toMatch(/no console entries at level "error"/i);
    expect(result.note).toMatch(/2 entries at other levels/i);
    expect(result.note).not.toMatch(/logged nothing/i);
  });

  it('resolves the session id at read time, surviving a first-turn rekey', async () => {
    // The buffer lives under the CANONICAL id (the client + ingest switched to
    // it mid-first-turn); the id known at registration time was the request
    // UUID. A resolver reading the live session's sdkSessionId must hit it.
    const store = seededStore([consoleEntry({ text: 'rekeyed', timestamp: 1 })], [], 'canonical');
    const session = { sdkSessionId: 'request-uuid' };
    const handler = createReadConsoleHandler(() => session.sdkSessionId, store);

    // The SDK init assigns the canonical id AFTER the tools were registered.
    session.sdkSessionId = 'canonical';

    const result = parse(await handler({}));
    expect((result.entries as DevtoolsConsoleEntry[])[0]?.text).toBe('rekeyed');
    expect(result.note).toBeUndefined();
  });

  it('returns an invalid-input error for an out-of-range limit', async () => {
    const store = seededStore([consoleEntry()]);
    const result = await createReadConsoleHandler(resolveSession, store)({ limit: 501 });

    expect(result.isError).toBe(true);
    expect(parse(result).error).toBe('Invalid input');
  });
});

describe('browser_read_network handler', () => {
  it('returns captured requests with method/url/status/duration/size', async () => {
    const store = seededStore(
      [],
      [networkEntry({ status: 404, ok: false, responseSize: 128, timestamp: 5 })]
    );
    const result = parse(await createReadNetworkHandler(resolveSession, store)({}));

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

  it('"failed" matches network errors and 4xx/5xx, never redirects', async () => {
    const store = seededStore(
      [],
      [
        networkEntry({ status: 200, ok: true, timestamp: 1 }),
        // A redirect an XHR capture may have recorded with ok=false — still not
        // a failure: "failed" is status-based, identical for fetch and XHR.
        networkEntry({ status: 302, ok: false, timestamp: 2 }),
        networkEntry({ status: 0, ok: false, timestamp: 3 }),
        networkEntry({ status: 500, ok: false, timestamp: 4 }),
      ]
    );
    const result = parse(
      await createReadNetworkHandler(resolveSession, store)({ status: 'failed' })
    );

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests.map((r) => r.status)).toEqual([0, 500]);
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
    const result = parse(await createReadNetworkHandler(resolveSession, store)({ status: '4xx' }));

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
    const result = parse(await createReadNetworkHandler(resolveSession, store)({ limit: 2 }));

    const requests = result.requests as DevtoolsNetworkEntry[];
    expect(requests.map((r) => r.url)).toEqual(['http://localhost/4', 'http://localhost/5']);
    expect(result.truncated).toBe(true);
  });

  it('caps limit at the network ring size (200), not the console ring size', async () => {
    const store = seededStore([], [networkEntry()]);
    const rejected = await createReadNetworkHandler(resolveSession, store)({ limit: 300 });
    expect(rejected.isError).toBe(true);
    expect(parse(rejected).error).toBe('Invalid input');

    const accepted = await createReadNetworkHandler(resolveSession, store)({ limit: 200 });
    expect(accepted.isError).toBeUndefined();
  });

  it('says requests exist at other statuses when the filter matches nothing', async () => {
    const store = seededStore([], [networkEntry({ status: 200, ok: true, timestamp: 1 })]);
    const result = parse(
      await createReadNetworkHandler(resolveSession, store)({ status: 'failed' })
    );

    expect(result.requests).toEqual([]);
    expect(result.note).toMatch(/no requests matching status "failed"/i);
    expect(result.note).toMatch(/1 captured request in total/i);
  });

  it('returns the no-preview note when nothing captured', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadNetworkHandler(resolveSession, store)({}));

    expect(result.requests).toEqual([]);
    expect(result.note).toMatch(/browser_navigate/i);
  });
});

describe('getDevtoolsTools registration', () => {
  const emptyDeps = {} as McpToolDeps;

  it('registers exactly browser_read_console and browser_read_network', () => {
    const tools = getDevtoolsTools(
      emptyDeps,
      resolveSession,
      new DevtoolsCaptureStore()
    ) as unknown as MockTool[];
    expect(tools.map((t) => t.name)).toEqual(['browser_read_console', 'browser_read_network']);
  });

  it('returns a session-less error when no resolver is bound', async () => {
    const tools = getDevtoolsTools(
      emptyDeps,
      undefined,
      new DevtoolsCaptureStore()
    ) as unknown as MockTool[];
    for (const t of tools) {
      const result = await t.handler({});
      expect(result.isError).toBe(true);
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.error).toMatch(/require an attached interactive session/i);
      expect(parsed.entries).toBeUndefined();
      expect(parsed.requests).toBeUndefined();
    }
  });

  it('returns a session-less error when the resolver yields no id', async () => {
    const tools = getDevtoolsTools(
      emptyDeps,
      () => undefined,
      new DevtoolsCaptureStore()
    ) as unknown as MockTool[];
    for (const t of tools) {
      const result = await t.handler({});
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.content[0].text).error).toMatch(
        /require an attached interactive session/i
      );
    }
  });

  it('reads the bound session buffer when a resolver is bound', async () => {
    const store = seededStore([consoleEntry({ text: 'live', timestamp: 1 })]);
    const [readConsole] = getDevtoolsTools(
      emptyDeps,
      resolveSession,
      store
    ) as unknown as MockTool[];
    const parsed = JSON.parse((await readConsole.handler({})).content[0].text);
    expect((parsed.entries as DevtoolsConsoleEntry[])[0].text).toBe('live');
  });
});
