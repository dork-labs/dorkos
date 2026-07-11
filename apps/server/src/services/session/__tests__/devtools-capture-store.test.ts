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
});
