/** The console and network reads: what they return, filter and cut. */
import { describe, it, expect } from 'vitest';
import type { DevtoolsConsoleEntry, DevtoolsNetworkEntry } from '@dorkos/shared/schemas';
import { noopLogger } from '@dorkos/shared/logger';
import { composeRegistry } from '../../../core/capabilities/index.js';
import { uiDomain } from '../ui-capabilities.js';
import { DevtoolsCaptureStore } from '../../devtools-capture-store.js';
import {
  SESSION_ID,
  resolveSession,
  createReadConsoleHandler,
  createReadNetworkHandler,
  parse,
  consoleEntry,
  networkEntry,
  seededStore,
} from './devtools-reads.fixtures.js';

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

  it('returns the no-preview note when the session never captured anything', async () => {
    const store = new DevtoolsCaptureStore();
    const result = parse(await createReadConsoleHandler(resolveSession, store)({}));

    expect(result.entries).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.note).toMatch(/browser_navigate/i);
    expect(result.documentUrl).toBeUndefined();
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

  it('refuses an out-of-range limit at the registry, before the handler runs', async () => {
    // The bound moved with the verb: the capability's own input schema is what
    // the tool advertises and what `registry.invoke` parses against, so a `limit`
    // past the ring size is refused before any buffer is touched.
    const registry = composeRegistry([uiDomain], { logger: noopLogger });

    await expect(
      registry.invoke('ui.read_console', { limit: 501 }, { sessionId: SESSION_ID })
    ).rejects.toThrow(/limit/i);
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
});
