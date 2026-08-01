/**
 * The relay trace becomes a real trace.
 *
 * `relayTraces` has had a `traceId` column, an index on it, and a
 * `getTrace(traceId)` query since it was built — and it has been degenerate the
 * whole time, because `relay-publish.ts` set `traceId = messageId` on every row.
 * Every trace had exactly one span, so `getTrace` could only ever return the row
 * you already had.
 *
 * Carrying the dispatch id through the publish makes all hops of one dispatch
 * share a `traceId`. **Asserting `> 1` span is the entire point of this file**:
 * before the change that number was 1, always, no matter how many hops ran.
 *
 * Driven through the real `RelayCore` and the real `TraceStore` over a real
 * (in-memory) database — a mock trace store would only prove what the mock was
 * told to record.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RelayCore } from '@dorkos/relay';
import { createTestDb } from '@dorkos/test-utils/db';
import { newDispatchId } from '@dorkos/shared/dispatch-id';
import { TraceStore } from '../trace-store.js';

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

  it('joins two hops that share a dispatch id into one multi-span trace', async () => {
    const dispatchId = newDispatchId();

    const first = await relay.publish(
      'relay.test.first',
      { content: 'inbound' },
      { from: 'relay.test.sender', dispatchId }
    );
    const second = await relay.publish(
      'relay.test.second',
      { content: 'republished' },
      { from: 'relay.test.sender', dispatchId }
    );

    // Two hops, two unrelated message ids — that is the gap the id closes.
    expect(first.messageId).not.toBe(second.messageId);

    const trace = traces.getTrace(dispatchId);
    expect(trace.length).toBeGreaterThan(1);
    expect(trace.map((span) => span.messageId).sort()).toEqual(
      [first.messageId, second.messageId].sort()
    );
  });

  it('leaves a publish with no dispatch id exactly as it was', async () => {
    // The field is optional and every pre-existing producer omits it. Such a
    // publish must keep its historical single-span trace keyed by its own
    // message id, or the change would break every caller that never opted in.
    const result = await relay.publish(
      'relay.test.first',
      { content: 'legacy' },
      { from: 'relay.test.sender' }
    );

    const trace = traces.getTrace(result.messageId);
    expect(trace).toHaveLength(1);
    expect(trace[0].traceId).toBe(result.messageId);
  });

  it('keeps two different dispatches in two different traces', async () => {
    // A shared traceId that grouped everything would satisfy the first test
    // just as well as a correct one does.
    const a = newDispatchId();
    const b = newDispatchId();
    await relay.publish('relay.test.first', {}, { from: 'relay.test.sender', dispatchId: a });
    await relay.publish('relay.test.first', {}, { from: 'relay.test.sender', dispatchId: a });
    await relay.publish('relay.test.second', {}, { from: 'relay.test.sender', dispatchId: b });

    expect(traces.getTrace(a)).toHaveLength(2);
    expect(traces.getTrace(b)).toHaveLength(1);
  });
});
