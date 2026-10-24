/**
 * A window watching a chat must hear the chat's next turn after the session was
 * evicted for being idle (the "reply only shows after a refresh" bug).
 *
 * What happened: Claude Code evicts a session after thirty idle minutes and
 * drops its projector. A window still had the chat open, its stream parked on
 * that projector. The person's next prompt minted a fresh projector and the
 * turn was fed there; the window's stream, still open and still getting
 * heartbeats, heard nothing, so the app showed no working indicator and no
 * reply until a refresh re-snapshotted. Seen on 2026-10-18 in a long chat whose
 * earlier turns were started by other agents' messages, idle for two hours.
 *
 * Driven through the real `deliverSessionStream`, the real projector registry
 * and the real `disposeProjector` eviction calls; only the runtime (a thin
 * adapter over the registry, the way Claude Code's is) and the sink are faked.
 *
 * @module services/core/streams/tests/session-stream-eviction
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { AgentRuntime, SessionOpts } from '@dorkos/shared/agent-runtime';
import type { StreamFrame } from '@dorkos/shared/stream-socket';
import {
  disposeProjector,
  getOrCreateProjector,
  peekProjector,
  streamGenerationOf,
  type RawSessionEvent,
} from '../../../session/session-state-projector.js';
import { parseResumeCursor } from '../../../../lib/stream-cursor.js';
import { logger } from '../../../../lib/logger.js';
import type { DurableStreamSink } from '../durable-stream-sink.js';
import { deliverSessionStream } from '../session-stream-delivery.js';
import {
  __resetSessionStreamWatchForTests,
  openSessionStream,
  openSessionStreamCount,
  watchSessionStreamHealth,
} from '../session-stream-watch.js';

const SESSION = 'eviction-session';
const ctx = { cwd: '/tmp/project' } as SessionOpts;

/** A runtime that reads the projector registry the way Claude Code's adapter does. */
const runtime = {
  getInternalSessionId: () => undefined,
  streamGeneration: (_ctx: SessionOpts, id: string) => streamGenerationOf(peekProjector(id)),
  getSessionSnapshot: (_ctx: SessionOpts, id: string) =>
    getOrCreateProjector(id).buildSnapshot(async () => []),
  subscribeSession: (_ctx: SessionOpts, id: string, since?: number, signal?: AbortSignal) =>
    getOrCreateProjector(id).subscribe(since, signal),
} as unknown as AgentRuntime;

/** One app window's stream: keeps every frame, and can be closed by either side. */
class WindowSink implements DurableStreamSink {
  readonly frames: StreamFrame[] = [];
  /** Set when the SERVER ended the stream (the window will reconnect). */
  endedByServer = false;
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private left = false;

  get closed(): boolean {
    return this.left;
  }

  async send(frame: StreamFrame): Promise<void> {
    this.frames.push(frame);
  }

  end(): void {
    if (!this.left) this.endedByServer = true;
  }

  /** The window goes away. */
  leave(): void {
    this.left = true;
    this.controller.abort();
  }

  events(): string[] {
    return this.frames.map((f) => f.event);
  }

  /** The resume cursor the window would reconnect with. */
  lastId(): string | undefined {
    return [...this.frames].reverse().find((f) => f.id !== undefined)?.id;
  }
}

/** Open one window on the chat; resolves when its stream ends. */
function openWindow(sink: WindowSink, lastEventId?: string): Promise<void> {
  return deliverSessionStream(sink, {
    sessionId: SESSION,
    runtime,
    ctx,
    resume: parseResumeCursor(lastEventId, undefined),
    principal: { kind: 'operator' },
  });
}

/** Feed one whole turn into whatever projector the registry holds now. */
function runTurn(text: string): void {
  const projector = getOrCreateProjector(SESSION, ctx.cwd);
  projector.ingest({ type: 'turn_start' });
  projector.ingest({ type: 'text_delta', text } as RawSessionEvent);
  projector.ingest({ type: 'turn_end' });
}

describe('a chat left open while its session is evicted', () => {
  afterEach(() => {
    disposeProjector(SESSION);
    __resetSessionStreamWatchForTests();
    vi.restoreAllMocks();
  });

  it('ends the window’s stream, and the reconnect hears the next prompt’s turn', async () => {
    const first = new WindowSink();
    const firstDone = openWindow(first);
    await vi.waitFor(() => expect(first.events()).toContain('snapshot'));

    // A turn another agent's message started: the open window hears it live.
    runTurn('Done with the helper’s report.');
    await vi.waitFor(() => expect(first.events()).toContain('turn_end'));

    // Thirty idle minutes later the session is evicted (`sweepEvictedSessions`).
    disposeProjector(SESSION);

    // The window's stream ends rather than sitting on a dead feed…
    await vi.waitFor(() => expect(first.endedByServer).toBe(true), { timeout: 1_000 });
    await firstDone;
    expect(openSessionStreamCount(SESSION)).toBe(0);

    // …so it reconnects with its cursor. That cursor names the dropped feed's
    // seq space, so the server answers with a fresh snapshot, not a replay.
    const second = new WindowSink();
    const secondDone = openWindow(second, first.lastId());
    await vi.waitFor(() => expect(second.events()).toEqual(['snapshot']));

    // The person's next prompt runs on a fresh projector, and the window hears it.
    runTurn('Cloudflare Pages vs Vercel: here is the short version.');
    await vi.waitFor(() =>
      expect(second.events()).toEqual(['snapshot', 'turn_start', 'text_delta', 'turn_end'])
    );

    second.leave();
    await secondDone;
  });

  it('warns when a turn starts on a feed no open window is reading', () => {
    const warn = vi.spyOn(logger, 'warn');
    const stop = watchSessionStreamHealth();
    // A window holds this chat's stream open, but on some other feed: the
    // shape a stranded stream has, which no path should produce any more.
    const release = openSessionStream([SESSION]);

    getOrCreateProjector(SESSION, ctx.cwd).ingest({ type: 'turn_start' });

    expect(warn).toHaveBeenCalledWith(
      '[session stream] a turn started that no open window will see',
      { sessionId: SESSION, openWindows: 1, liveSubscribers: 0 }
    );
    release();
    stop();
  });

  it('stays quiet when the open window reads the feed the turn runs on', async () => {
    const warn = vi.spyOn(logger, 'warn');
    const stop = watchSessionStreamHealth();
    const window = new WindowSink();
    const done = openWindow(window);
    await vi.waitFor(() => expect(window.events()).toContain('snapshot'));

    runTurn('Hello.');
    await vi.waitFor(() => expect(window.events()).toContain('turn_end'));

    expect(warn).not.toHaveBeenCalledWith(
      '[session stream] a turn started that no open window will see',
      expect.anything()
    );
    stop();
    window.leave();
    await done;
  });
});
