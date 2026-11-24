/**
 * The GC sweep's delivery-trace retention, driven through a real RelayCore with
 * a recording trace store. The Maildir and index sweeps are in `relay-gc.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadCeilingMs } from '@dorkos/shared/test-budget';
import { RelayCore } from '../relay-core.js';

/** A sweep interval large enough never to fire during a test. */
const NEVER_MS = 60 * 60 * 1000;

vi.setConfig({
  testTimeout: loadCeilingMs(5_000),
  hookTimeout: Math.min(60_000, loadCeilingMs(10_000)),
});

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-gc-traces-test-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('GC trace retention', () => {
  const HOUR = 60 * 60 * 1000;
  const DAY = 24 * HOUR;

  /** A trace store that records what the sweep asked of it. */
  function recordingTraces() {
    const calls: { before: number; limit: number }[] = [];
    let batches: number[] = [];
    let capped = 0;
    let caps = 0;
    return {
      calls,
      caps: () => caps,
      /** Forget the construction-time sweep, and answer the next one with these counts. */
      reset(next: number[], cap = 0) {
        calls.length = 0;
        caps = 0;
        batches = [...next];
        capped = cap;
      },
      store: {
        insertSpan() {},
        updateSpan() {},
        pruneDeliverySpans(before: number, limit: number) {
          calls.push({ before, limit });
          return batches.shift() ?? 0;
        },
        capAdapterEvents() {
          caps++;
          return capped;
        },
      },
    };
  }

  /** A relay whose construction-time sweep has finished with the trace store. */
  async function settledRelay(
    traces: ReturnType<typeof recordingTraces>,
    options: { undeliveredMailRetentionMs?: number; deadLetterRetentionMs?: number } = {}
  ) {
    const relay = new RelayCore({
      dataDir: tmpDir,
      gcIntervalMs: NEVER_MS,
      traceStore: traces.store,
      ...options,
    });
    await vi.waitFor(() => expect(traces.caps()).toBe(1));
    return relay;
  }

  it('keeps delivery traces as long as unread mail and then its dead letter can live', async () => {
    const traces = recordingTraces();
    const relay = await settledRelay(traces, {
      undeliveredMailRetentionMs: 3 * DAY,
      deadLetterRetentionMs: DAY,
    });
    traces.reset([7], 3);
    const started = Date.now();

    const result = await relay.runGcSweep();

    expect(traces.calls).toHaveLength(1);
    const age = started - traces.calls[0]!.before;
    expect(age).toBeGreaterThanOrEqual(4 * DAY - 1000);
    expect(age).toBeLessThanOrEqual(4 * DAY);
    expect(result?.tracesPruned).toBe(10);
    await relay.close();
  });

  it('never prunes into the day the delivery metrics count', async () => {
    const traces = recordingTraces();
    const relay = await settledRelay(traces, {
      undeliveredMailRetentionMs: HOUR,
      deadLetterRetentionMs: HOUR,
    });
    traces.reset([]);
    const started = Date.now();

    await relay.runGcSweep();

    expect(started - traces.calls[0]!.before).toBeGreaterThanOrEqual(DAY - 1000);
    await relay.close();
  });

  it('deletes in batches until one comes back short, then caps adapter events once', async () => {
    const traces = recordingTraces();
    const relay = await settledRelay(traces);
    traces.reset([5_000, 5_000, 12], 4);

    const result = await relay.runGcSweep();

    expect(traces.calls.map((call) => call.limit)).toEqual([5_000, 5_000, 5_000]);
    expect(traces.caps()).toBe(1);
    expect(result?.tracesPruned).toBe(10_016);
    await relay.close();
  });
});
