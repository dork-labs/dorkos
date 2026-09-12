/**
 * The session canvas rides the snapshot — the one line that puts it there
 * (spec `canvas-agent-seat` §1.4; DOR-2006 review finding 5).
 *
 * **This file exists because the guard that was supposed to cover it cannot
 * fail.** `SessionSnapshotSchema.canvas` is a required field, and the TSDoc
 * there says a transport that forgot to decorate its snapshot "fails a test
 * instead of quietly answering with an empty table" — but every runtime's
 * snapshot already carries `canvas: []`, so deleting the decoration typechecks
 * and ships an empty canvas to every window that connects. Measured: with the
 * line removed, five files and eighty tests stayed green.
 *
 * So the decoration is asserted where it happens, through the real
 * `deliverSessionStream` and the real `CanvasService`, with only the runtime and
 * the sink faked — the runtime because §1.4's whole point is that a runtime does
 * NOT own this storage, and the sink because the frames are the observation.
 *
 * @module services/core/streams/tests/session-stream-canvas
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createDb, runMigrations, type Db } from '@dorkos/db';
import { FakeAgentRuntime } from '@dorkos/test-utils';
import type { SessionOpts } from '@dorkos/shared/agent-runtime';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import type { SessionSnapshot } from '@dorkos/shared/session-stream';
import { CanvasDocumentStore } from '../../../canvas/canvas-document-store.js';
import { CanvasService } from '../../../canvas/canvas-service.js';
import { setCanvasService } from '../../../canvas/index.js';
import { sessionScope, SESSION_OWNER_AUTHOR } from '../../../canvas/scopes.js';
import type { DurableStreamSink } from '../durable-stream-sink.js';
import { deliverSessionStream } from '../session-stream-delivery.js';

const SESSION = 'sess-streamed';

/** A sink that keeps every frame, the way a reader would see them. */
class CollectingSink implements DurableStreamSink {
  readonly frames: StreamFrame[] = [];
  closed = false;
  readonly signal = new AbortController().signal;

  async send(frame: StreamFrame): Promise<void> {
    this.frames.push(frame);
  }

  end(): void {
    this.closed = true;
  }
}

/** The snapshot frame, parsed as the snapshot it carries. */
function snapshotFrom(sink: CollectingSink): SessionSnapshot {
  const frame = sink.frames.find((f) => f.event === 'snapshot');
  if (!frame) throw new Error('no snapshot frame was sent');
  return frame.data as SessionSnapshot;
}

describe('the snapshot a cold connect receives', () => {
  let db: Db;
  let canvas: CanvasService;
  let runtime: FakeAgentRuntime;
  const ctx = { cwd: '/tmp/project' } as SessionOpts;

  beforeEach(() => {
    db = createDb(':memory:');
    runMigrations(db);
    canvas = new CanvasService({
      documents: new CanvasDocumentStore(db),
      channels: { publish: () => {}, viewers: () => 0 },
    });
    runtime = new FakeAgentRuntime();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    db.$client.close();
  });

  it('carries this session’s canvas, which no runtime knows about', async () => {
    setCanvasService(canvas);
    canvas.open(sessionScope(SESSION), SESSION_OWNER_AUTHOR, {
      type: 'file',
      sourcePath: '/src/router.ts',
    });
    const sink = new CollectingSink();
    // The runtime's own snapshot answers `canvas: []` — always, by contract.
    expect((await runtime.getSessionSnapshot(ctx, SESSION)).canvas).toEqual([]);

    await deliverSessionStream(sink, {
      sessionId: SESSION,
      runtime,
      ctx,
      resume: undefined,
      principal: { kind: 'operator' },
    });

    // What reaches the reader is the server's table.
    expect(snapshotFrom(sink).canvas.map((d) => d.content)).toEqual([
      { type: 'file', sourcePath: '/src/router.ts' },
    ]);
  });

  it('carries only THIS session’s canvas', async () => {
    setCanvasService(canvas);
    canvas.open(sessionScope('sess-other'), SESSION_OWNER_AUTHOR, {
      type: 'file',
      sourcePath: '/src/elsewhere.ts',
    });
    const sink = new CollectingSink();

    await deliverSessionStream(sink, {
      sessionId: SESSION,
      runtime,
      ctx,
      resume: undefined,
      principal: { kind: 'operator' },
    });

    expect(snapshotFrom(sink).canvas).toEqual([]);
  });

  it('answers the empty table on a host that stood no canvas up', async () => {
    // The Obsidian embed and a server mid-boot: no canvas service is registered
    // at all. A stream that failed here would take the whole session down over
    // a table nobody asked for. A fresh module graph is how "registered
    // nothing" is expressed — there is deliberately no unregister.
    vi.resetModules();
    const fresh = await import('../session-stream-delivery.js');
    const { peekCanvasService } = await import('../../../canvas/index.js');
    expect(peekCanvasService()).toBeUndefined();
    const sink = new CollectingSink();

    await fresh.deliverSessionStream(sink, {
      sessionId: SESSION,
      runtime,
      ctx,
      resume: undefined,
      principal: { kind: 'operator' },
    });

    expect(snapshotFrom(sink).canvas).toEqual([]);
  });
});
