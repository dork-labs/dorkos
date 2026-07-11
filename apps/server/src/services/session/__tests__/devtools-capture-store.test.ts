import { describe, it, expect } from 'vitest';
import type {
  DevtoolsConsoleEntry,
  DevtoolsIngest,
  DevtoolsNetworkEntry,
} from '@dorkos/shared/schemas';
import { DevtoolsCaptureStore } from '../devtools-capture-store.js';
import { WORKBENCH } from '../../../config/constants.js';

function consoleEntry(text: string): DevtoolsConsoleEntry {
  return { level: 'log', text, timestamp: Date.now() };
}
function networkEntry(url: string): DevtoolsNetworkEntry {
  return { method: 'GET', url, status: 200, ok: true, durationMs: 1, timestamp: Date.now() };
}
function batch(over: Partial<DevtoolsIngest> = {}): DevtoolsIngest {
  return { seq: 1, console: [], network: [], ...over };
}

describe('DevtoolsCaptureStore', () => {
  it('appends console + network and reads them back', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s1', batch({ console: [consoleEntry('hi')], network: [networkEntry('/a')] }));
    const buf = store.read('s1');
    expect(buf?.console).toHaveLength(1);
    expect(buf?.console[0].text).toBe('hi');
    expect(buf?.network[0].url).toBe('/a');
    expect(buf?.screenshot).toBeNull();
  });

  it('returns undefined for a session that never ingested', () => {
    expect(new DevtoolsCaptureStore().read('nobody')).toBeUndefined();
  });

  it('evicts the oldest console entry past the cap (ring semantics)', () => {
    const store = new DevtoolsCaptureStore();
    const cap = WORKBENCH.DEVTOOLS_CONSOLE_BUFFER;
    // One more than the cap: the first entry must fall off.
    const entries = Array.from({ length: cap + 1 }, (_, i) => consoleEntry(`line-${i}`));
    store.ingest('s1', batch({ console: entries }));
    const buf = store.read('s1');
    expect(buf?.console).toHaveLength(cap);
    expect(buf?.console[0].text).toBe('line-1'); // line-0 evicted
    expect(buf?.console[cap - 1].text).toBe(`line-${cap}`);
  });

  it('bounds the network ring at its own cap', () => {
    const store = new DevtoolsCaptureStore();
    const cap = WORKBENCH.DEVTOOLS_NETWORK_BUFFER;
    store.ingest(
      's1',
      batch({ network: Array.from({ length: cap + 5 }, (_, i) => networkEntry(`/${i}`)) })
    );
    expect(store.read('s1')?.network).toHaveLength(cap);
  });

  it('isolates sessions — one never reads another', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('a', batch({ console: [consoleEntry('from-a')] }));
    store.ingest('b', batch({ console: [consoleEntry('from-b')] }));
    expect(store.read('a')?.console[0].text).toBe('from-a');
    expect(store.read('b')?.console[0].text).toBe('from-b');
    expect(store.read('a')?.console).toHaveLength(1);
  });

  it('clears console + network on a reset (navigation boundary)', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s1', batch({ console: [consoleEntry('old')] }));
    store.ingest('s1', batch({ reset: true, console: [consoleEntry('new')] }));
    const buf = store.read('s1');
    expect(buf?.console).toHaveLength(1);
    expect(buf?.console[0].text).toBe('new');
  });

  it('tracks documentId / logicalUrl / lastSeq', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s1', batch({ seq: 7, documentId: 'doc-1', logicalUrl: 'preview.html' }));
    const buf = store.read('s1');
    expect(buf?.documentId).toBe('doc-1');
    expect(buf?.logicalUrl).toBe('preview.html');
    expect(buf?.lastSeq).toBe(7);
  });

  it('drops a session buffer on close', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s1', batch({ console: [consoleEntry('hi')] }));
    store.dropSession('s1');
    expect(store.read('s1')).toBeUndefined();
  });

  it('rekeys a buffer from the request UUID to the canonical id', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('uuid', batch({ console: [consoleEntry('carried')] }));
    store.rekeySession('uuid', 'canonical');
    expect(store.read('uuid')).toBeUndefined();
    expect(store.read('canonical')?.console[0].text).toBe('carried');
  });

  it('enforces the per-session byte budget, evicting oldest console entries first', () => {
    const store = new DevtoolsCaptureStore();
    // 100 entries of ~19 KB text each ≈ 1.9 MB — well under the 500-entry count
    // cap but roughly double the 1 MB byte budget, so the count cap alone would
    // retain everything and only byte accounting trims.
    const big = (i: number): DevtoolsConsoleEntry => ({
      level: 'log',
      text: `${i}:${'x'.repeat(19_000)}`,
      timestamp: i,
    });
    store.ingest('s1', batch({ console: Array.from({ length: 100 }, (_, i) => big(i)) }));

    const buf = store.read('s1');
    expect(buf).toBeDefined();
    expect(buf!.approxBytes).toBeLessThanOrEqual(WORKBENCH.DEVTOOLS_SESSION_MAX_BYTES);
    expect(buf!.console.length).toBeLessThan(100); // oldest evicted by bytes…
    expect(buf!.console.length).toBeGreaterThan(0); // …but not everything
    // Oldest-first: the survivors are the newest entries.
    expect(buf!.console[0].text.startsWith('0:')).toBe(false);
    expect(buf!.console.at(-1)!.text.startsWith('99:')).toBe(true);
  });

  it('frees the byte budget on a navigation reset', () => {
    const store = new DevtoolsCaptureStore();
    const big: DevtoolsConsoleEntry = { level: 'log', text: 'y'.repeat(19_000), timestamp: 1 };
    store.ingest('s1', batch({ console: Array.from({ length: 50 }, () => ({ ...big })) }));
    expect(store.read('s1')!.approxBytes).toBeGreaterThan(0);

    store.ingest('s1', batch({ reset: true, console: [consoleEntry('fresh')] }));
    const buf = store.read('s1')!;
    expect(buf.console).toHaveLength(1);
    // approxBytes reflects only the post-reset entry, not the cleared page's.
    expect(buf.approxBytes).toBeLessThan(1_000);
  });

  it('keeps byte accounting in sync through count-cap trims', () => {
    const store = new DevtoolsCaptureStore();
    const cap = WORKBENCH.DEVTOOLS_NETWORK_BUFFER;
    store.ingest(
      's1',
      batch({ network: Array.from({ length: cap + 50 }, (_, i) => networkEntry(`/${i}`)) })
    );
    const buf = store.read('s1')!;
    const actual = buf.network.reduce((sum, e) => sum + JSON.stringify(e).length, 0);
    expect(buf.approxBytes).toBe(actual);
  });

  it('reports no eviction while both rings are within bounds', () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s1', batch({ console: [consoleEntry('hi')], network: [networkEntry('/a')] }));
    const buf = store.read('s1')!;
    expect(buf.consoleEvicted).toBe(false);
    expect(buf.networkEvicted).toBe(false);
  });

  it('flags the console ring evicted when the count cap drops entries', () => {
    const store = new DevtoolsCaptureStore();
    const cap = WORKBENCH.DEVTOOLS_CONSOLE_BUFFER;
    store.ingest(
      's1',
      batch({ console: Array.from({ length: cap + 1 }, (_, i) => consoleEntry(`l${i}`)) })
    );
    const buf = store.read('s1')!;
    expect(buf.consoleEvicted).toBe(true);
    expect(buf.networkEvicted).toBe(false); // the untouched ring stays clean
  });

  it('flags the console ring evicted when the byte budget drops entries below the count cap', () => {
    const store = new DevtoolsCaptureStore();
    // ~60 × ~20 KB ≈ 1.2 MB: over the 1 MB byte budget, far under the 500 count
    // cap — the flag must come from trimBytes, not trimCount.
    const big = (i: number): DevtoolsConsoleEntry => ({
      level: 'log',
      text: `${i}:${'x'.repeat(20_000)}`,
      timestamp: i,
    });
    store.ingest('s1', batch({ console: Array.from({ length: 60 }, (_, i) => big(i)) }));
    const buf = store.read('s1')!;
    expect(buf.console.length).toBeLessThan(WORKBENCH.DEVTOOLS_CONSOLE_BUFFER);
    expect(buf.consoleEvicted).toBe(true);
  });

  it('clears eviction flags on a navigation reset (new page starts clean)', () => {
    const store = new DevtoolsCaptureStore();
    const cap = WORKBENCH.DEVTOOLS_CONSOLE_BUFFER;
    store.ingest(
      's1',
      batch({ console: Array.from({ length: cap + 1 }, (_, i) => consoleEntry(`l${i}`)) })
    );
    expect(store.read('s1')!.consoleEvicted).toBe(true);

    store.ingest('s1', batch({ reset: true, console: [consoleEntry('fresh')] }));
    expect(store.read('s1')!.consoleEvicted).toBe(false);
  });

  it('evicts the least-recently-updated buffer past the session cap', () => {
    const store = new DevtoolsCaptureStore();
    const max = WORKBENCH.DEVTOOLS_MAX_SESSIONS;
    for (let i = 0; i < max; i++) store.ingest(`s${i}`, batch());
    expect(store.size).toBe(max);
    // One more session must evict exactly one (the oldest, s0).
    store.ingest('overflow', batch());
    expect(store.size).toBe(max);
    expect(store.read('s0')).toBeUndefined();
    expect(store.read('overflow')).toBeDefined();
  });

  describe('screenshot round-trip', () => {
    const PNG = 'data:image/png;base64,AAAA';

    it('stores an ingested screenshot in the single slot and exposes it on read', () => {
      const store = new DevtoolsCaptureStore();
      store.ingest('s1', batch({ screenshot: { requestId: 'r1', dataUrl: PNG } }));
      const shot = store.read('s1')!.screenshot;
      expect(shot?.dataUrl).toBe(PNG);
      expect(shot?.requestId).toBe('r1');
      expect(typeof shot?.capturedAt).toBe('number');
    });

    it('resolves an awaiting call when the matching ingest arrives', async () => {
      const store = new DevtoolsCaptureStore();
      const pending = store.awaitScreenshot('r1', 5_000);
      store.ingest('s1', batch({ screenshot: { requestId: 'r1', dataUrl: PNG } }));
      const outcome = await pending;
      expect(outcome).toEqual({
        ok: true,
        screenshot: expect.objectContaining({ dataUrl: PNG, requestId: 'r1' }),
      });
    });

    it('resolves with the shim error when rasterization failed (no slot write)', async () => {
      const store = new DevtoolsCaptureStore();
      const pending = store.awaitScreenshot('r1', 5_000);
      store.ingest('s1', batch({ screenshot: { requestId: 'r1', error: 'CSP blocked' } }));
      expect(await pending).toEqual({ ok: false, error: 'CSP blocked' });
      expect(store.read('s1')!.screenshot).toBeNull();
    });

    it('resolves undefined after the timeout — never hangs', async () => {
      const store = new DevtoolsCaptureStore();
      expect(await store.awaitScreenshot('never', 20)).toBeUndefined();
    });

    it('ignores a non-matching requestId', async () => {
      const store = new DevtoolsCaptureStore();
      const pending = store.awaitScreenshot('r1', 30);
      store.ingest('s1', batch({ screenshot: { requestId: 'other', dataUrl: PNG } }));
      expect(await pending).toBeUndefined(); // timed out — 'other' never matched
    });

    it('resolves across a session rekey — the waiter is requestId-keyed', async () => {
      // The tool requests under the request UUID; the first-turn rekey means
      // the client may ingest under the CANONICAL id. The waiter must not care.
      const store = new DevtoolsCaptureStore();
      store.ingest('request-uuid', batch());
      const pending = store.awaitScreenshot('r1', 5_000);
      store.rekeySession('request-uuid', 'canonical');
      store.ingest('canonical', batch({ screenshot: { requestId: 'r1', dataUrl: PNG } }));
      const outcome = await pending;
      expect(outcome?.ok).toBe(true);
      expect(store.read('canonical')!.screenshot?.dataUrl).toBe(PNG);
    });
  });
});
