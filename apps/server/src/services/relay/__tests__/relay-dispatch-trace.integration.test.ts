/**
 * One dispatch that crosses the relay is one trace. `traceId` used to equal
 * `messageId` on every row, so every trace had exactly one span; asserting more
 * than one span is the point. Driven through the real `RelayCore` and
 * `TraceStore` over an in-memory database.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import { newDispatchId } from '../../../lib/identity/dispatch-id.js';
import { loadCeilingMs } from '@dorkos/shared/test-budget';
import { TraceStore } from '../trace-store.js';

// A real RelayCore's close() can outrun the 10s hook default on a loaded machine (DOR-2021).
vi.setConfig({
  testTimeout: loadCeilingMs(5_000),
  hookTimeout: Math.min(60_000, loadCeilingMs(10_000)),
});

describe('a dispatch that crosses the relay is one trace', () => {
  let dataDir: string;
  let relay: RelayCore;
  let traces: TraceStore;

  beforeEach(async () => {
    dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'relay-dispatch-trace-'));
    traces = new TraceStore(createTestDb());
    relay = new RelayCore({ dataDir, traceStore: traces });
    await relay.registerEndpoint('relay.test.first');
    await relay.registerEndpoint('relay.test.second');
  });

  afterEach(async () => {
    await relay.close();
    await fs.rm(dataDir, { recursive: true, force: true });
  });

  it('joins hops sharing a dispatch id, and keeps two dispatches apart', async () => {
    const a = newDispatchId();
    const b = newDispatchId();
    const first = await relay.publish(
      'relay.test.first',
      {},
      { from: 'relay.test.sender', dispatchId: a }
    );
    const second = await relay.publish(
      'relay.test.second',
      {},
      { from: 'relay.test.sender', dispatchId: a }
    );
    await relay.publish('relay.test.second', {}, { from: 'relay.test.sender', dispatchId: b });
    expect(
      traces
        .getTrace(a)
        .map((span) => span.messageId)
        .sort()
    ).toEqual([first.messageId, second.messageId].sort());
    expect(traces.getTrace(b)).toHaveLength(1);
  });

  it('keys a publish with no dispatch id by its own message id, as before', async () => {
    const result = await relay.publish('relay.test.first', {}, { from: 'relay.test.sender' });
    const trace = traces.getTrace(result.messageId);
    expect(trace).toHaveLength(1);
    expect(trace[0].traceId).toBe(result.messageId);
  });
});
