import { describe, it, expect, vi } from 'vitest';
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
      void store.awaitScreenshot('r1', 5000);
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

describe('bound bridge responses are atomic before buffer mutation', () => {
  const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
  const base = {
    documentId: 'doc',
    logicalUrl: 'preview.html',
    bridgeGeneration: 'generation',
    seq: 1,
    console: [],
    network: [],
  };
  it('rejects every wrong/missing binding and unknown screenshot without changing any buffer field', async () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('s', { ...base, active: true, instrumented: true }, 'host');
    store.ingest(
      's',
      { ...base, console: [{ level: 'log', text: 'original', timestamp: 1 }] },
      'host'
    );
    const original = store.read('s');
    const pending = store.awaitScreenshot('known', 5000, binding);
    const hostile = {
      ...base,
      reset: true,
      logicalUrl: 'forged',
      console: [{ level: 'error' as const, text: 'forged', timestamp: 2 }],
      network: [
        { method: 'GET', url: '/forged', status: 500, ok: false, durationMs: 0, timestamp: 2 },
      ],
      screenshot: { requestId: 'known', dataUrl: 'data:image/png;base64,AAAA' },
    };
    for (const [client, override] of [
      ['other', {}],
      [undefined, {}],
      ['host', { documentId: 'other' }],
      ['host', { documentId: undefined }],
      ['host', { bridgeGeneration: 'old' }],
      ['host', { bridgeGeneration: undefined }],
    ] as const) {
      store.ingest('s', { ...hostile, ...override }, client);
      expect(store.read('s')).toEqual(original);
    }
    store.ingest(
      's',
      { ...hostile, screenshot: { ...hostile.screenshot, requestId: 'unknown' } },
      'host'
    );
    expect(store.read('s')).toEqual(original);
    store.ingest('s', { ...base, screenshot: hostile.screenshot }, 'host');
    expect(await pending).toMatchObject({ ok: true });
    const accepted = store.read('s');
    store.ingest('s', hostile, 'host');
    expect(store.read('s')).toEqual(accepted);
  });
  it('allows one host-accepted pinned result after canonical rekey and claim retirement', async () => {
    const store = new DevtoolsCaptureStore();
    store.ingest('temporary', { ...base, active: true, instrumented: true }, 'host');
    const action = store.awaitAction('action', 5000, binding);
    const screenshot = store.awaitScreenshot('capture', 5000, binding);
    // The host already accepted these immutable results before deferring HTTP delivery.
    const acceptedScreenshot = {
      ...base,
      screenshot: { requestId: 'capture', dataUrl: 'data:image/png;base64,AAAA' },
    };
    const acceptedAction = {
      requestId: 'action',
      ok: true,
      documentId: 'doc',
      bridgeGeneration: 'generation',
    };
    store.ingest('temporary', { ...base, active: false }, 'host');
    store.rekeySession('temporary', 'canonical');
    store.ingest('canonical', { ...base, bridgeGeneration: 'replacement', active: true }, 'host');
    store.ingest('canonical', acceptedScreenshot, 'host');
    store.resolveAction(acceptedAction, 'host');
    expect(await screenshot).toMatchObject({ ok: true });
    expect(await action).toMatchObject({ ok: true });
    const accepted = store.read('canonical');
    store.ingest('canonical', acceptedScreenshot, 'host');
    expect(store.read('canonical')).toEqual(accepted);
    store.ingest(
      'canonical',
      { ...base, reset: true, console: [{ level: 'log', text: 'late page', timestamp: 2 }] },
      'host'
    );
    expect(store.read('canonical')).toEqual(accepted);
  });
  it('keeps explicitly issued legacy waiters working but never lets a bound waiter downgrade', async () => {
    const store = new DevtoolsCaptureStore();
    const legacy = store.awaitAction('legacy', 5000, { clientId: 'host', documentId: 'doc' });
    store.resolveAction({ requestId: 'legacy', documentId: 'doc', ok: true }, 'host');
    expect(await legacy).toMatchObject({ ok: true });
    const bound = store.awaitAction('bound', 5000, binding);
    store.resolveAction({ requestId: 'bound', documentId: 'doc', ok: false }, 'host');
    store.resolveAction(
      { requestId: 'bound', documentId: 'doc', bridgeGeneration: 'generation', ok: true },
      'host'
    );
    expect(await bound).toMatchObject({ ok: true });
  });
});

describe('exclusive recording upload ownership', () => {
  it('uses internal pending identity, rejects competing owners and preserves ownership across canonical rekey', async () => {
    const store = new DevtoolsCaptureStore();
    const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
    const claim = {
      ...binding,
      seq: 0,
      console: [],
      network: [],
      active: true,
      instrumented: true,
    };
    store.ingest('old', claim, 'host');
    const pending = store.awaitRecording(
      'upload',
      { recordingId: 'recording', cwd: '/tmp', full: false, binding },
      1000
    );
    expect(store.pendingRecording('upload')).not.toBe(store.pendingRecording('upload'));
    expect(
      store.claimRecordingUpload('upload', { ...binding, documentId: 'wrong' })
    ).toBeUndefined();
    const lease = store.claimRecordingUpload('upload', binding)!;
    expect(store.isRecordingUploadCurrent(lease)).toBe(true);
    expect(store.claimRecordingUpload('upload', binding)).toBeUndefined();
    store.releaseRecordingUpload({ ...lease });
    expect(store.isRecordingUploadCurrent(lease)).toBe(true);
    store.rekeySession('old', 'canonical');
    expect(store.isRecordingUploadCurrent(lease)).toBe(true);
    expect(store.resolveRecordingUpload({ ...lease }, { ok: false, error: 'Forged owner.' })).toBe(
      false
    );
    expect(
      store.resolveRecordingUpload(lease, {
        ok: false,
        error: 'Controlled host failure.',
        provenance: 'host',
      })
    ).toBe(true);
    expect(await pending).toMatchObject({ ok: false, provenance: 'host' });
    expect(store.isRecordingUploadCurrent(lease)).toBe(false);
    store.releaseRecordingUpload(lease);
  });

  it('an expired owner cannot settle or release a replacement request and holds exclusion until cleanup', async () => {
    vi.useFakeTimers();
    const store = new DevtoolsCaptureStore();
    const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'generation' };
    store.ingest(
      'session',
      { ...binding, seq: 0, console: [], network: [], active: true, instrumented: true },
      'host'
    );
    try {
      const old = store.awaitRecording(
        'upload',
        { recordingId: 'old', cwd: '/tmp', full: false, binding },
        50
      );
      const oldLease = store.claimRecordingUpload('upload', binding)!;
      await vi.advanceTimersByTimeAsync(50);
      expect(await old).toBeUndefined();
      const replacement = store.awaitRecording(
        'upload',
        { recordingId: 'new', cwd: '/tmp', full: false, binding },
        1000
      );
      expect(store.claimRecordingUpload('upload', binding)).toBeUndefined();
      expect(store.resolveRecordingUpload(oldLease, { ok: false, error: 'Stale catch.' })).toBe(
        false
      );
      expect(store.pendingRecording('upload')?.recordingId).toBe('new');
      store.releaseRecordingUpload(oldLease);
      const nextLease = store.claimRecordingUpload('upload', binding)!;
      store.releaseRecordingUpload(oldLease);
      expect(store.isRecordingUploadCurrent(nextLease)).toBe(true);
      expect(
        store.resolveRecordingUpload(nextLease, {
          ok: false,
          error: 'Host cleanup.',
          provenance: 'host',
        })
      ).toBe(true);
      await replacement;
      store.releaseRecordingUpload(nextLease);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.clear();
      vi.useRealTimers();
    }
  });
});

describe('host recording START admission', () => {
  it.each([
    'request',
    'recording',
    'phase',
    'client',
    'document',
    'generation',
    'missing-generation',
    'mixed',
  ])(
    'rejects %s without consuming the phase or mutating any capture/claim state',
    async (mismatch) => {
      vi.useFakeTimers();
      const store = new DevtoolsCaptureStore();
      try {
        const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'gen' };
        store.ingest(
          's1',
          batch({
            ...binding,
            active: true,
            instrumented: true,
            console: [consoleEntry('retained')],
          }),
          'host'
        );
        store.startRecording('s1', { id: 'film', ...binding });
        let settled = false;
        const wait = store
          .awaitRecordingStart('request', {
            recordingId: 'film',
            phase: 'reserved',
            binding,
            timeoutMs: 100,
          })
          .then((outcome) => {
            settled = true;
            return outcome;
          });
        const valid: DevtoolsIngest = {
          hostOutcome: 'host',
          documentId: 'doc',
          bridgeGeneration: 'gen',
          seq: 0,
          console: [],
          network: [],
          recordingStart: {
            requestId: 'request',
            recordingId: 'film',
            phase: 'reserved',
            ok: true,
          },
        };
        const wrong = structuredClone(valid);
        if (mismatch === 'request') wrong.recordingStart!.requestId = 'unknown';
        if (mismatch === 'recording') wrong.recordingStart!.recordingId = 'different';
        if (mismatch === 'phase') wrong.recordingStart!.phase = 'started';
        if (mismatch === 'document') wrong.documentId = 'different';
        if (mismatch === 'generation') wrong.bridgeGeneration = 'different';
        if (mismatch === 'missing-generation') delete wrong.bridgeGeneration;
        if (mismatch === 'mixed')
          Object.assign(wrong, {
            reset: true,
            logicalUrl: 'forged',
            active: false,
            console: [consoleEntry('forged')],
            network: [networkEntry('/forged')],
          });
        const before = store.read('s1');
        const recording = store.recordingFor('s1');
        store.ingest('s1', wrong, mismatch === 'client' ? 'different' : 'host');
        await Promise.resolve();
        expect(settled).toBe(false);
        expect(store.read('s1')).toEqual(before);
        expect(store.recordingFor('s1')).toEqual(recording);
        store.ingest('canonical-url', valid, 'host');
        expect(await wait).toEqual(valid.recordingStart);
        store.ingest('s1', valid, 'host');
        expect(store.read('s1')).toEqual(before);
      } finally {
        store.clear();
        vi.useRealTimers();
      }
    }
  );
  it('drops an expired phase and releases its waiter and timer promptly on cancellation', async () => {
    vi.useFakeTimers();
    const store = new DevtoolsCaptureStore();
    try {
      const binding = { clientId: 'host', documentId: 'doc', bridgeGeneration: 'gen' };
      const wait = store.awaitRecordingStart('request', {
        recordingId: 'film',
        phase: 'reserved',
        binding,
        timeoutMs: 100,
      });
      expect(vi.getTimerCount()).toBe(1);
      store.cancelRecordingStart('request');
      expect(await wait).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
      const expired = store.awaitRecordingStart('request', {
        recordingId: 'film',
        phase: 'started',
        binding,
        timeoutMs: 100,
      });
      await vi.advanceTimersByTimeAsync(101);
      expect(await expired).toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      store.clear();
      vi.useRealTimers();
    }
  });
});
