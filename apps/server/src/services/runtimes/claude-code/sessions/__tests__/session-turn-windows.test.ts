/**
 * Turn windowing over a real {@link SessionPump} (spec
 * `persistent-session-runtime` §5, task 3.3).
 *
 * Every case drives the WHOLE hop a live turn takes: a real pump over a
 * scripted subprocess, the windower cutting its output into windows, each
 * window's messages mapped by the production `mapSdkMessage` and fed to a real
 * projector by the production `feedProjector`. What the assertions read is the
 * durable stream itself — `turn_start`/`turn_end` pairs and what rode inside
 * them — because that is the thing the spec makes promises about.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-turn-windows
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';
import { initBoundary } from '../../../../../lib/boundary.js';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import { createToolState } from '../../agent-types.js';
import type { AgentSession } from '../../agent-types.js';
import { PumpRefusedError } from '../session-pump-contract.js';
import { SessionPump } from '../session-pump.js';
import { SessionTurnWindows, type TurnWindow, type WindowUsage } from '../session-turn-windows.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

const SESSION_ID = 'sess-1';

/**
 * The directory every dispatch in this file runs in — real, and inside the
 * boundary initialized below, because `dispatch` validates it before it sends
 * anything (task 3.9). What happens when it is NOT allowed is a subject of its
 * own, in `session-turn-windows-boundary.test.ts`.
 */
const CWD = process.cwd();

beforeAll(async () => {
  await initBoundary(CWD);
});

/** A `result` that answers `answers`, or one that answers nothing it can name. */
function resultMessage(answers?: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    uuid: `result-${answers ?? 'anonymous'}`,
    session_id: 'sdk-1',
    ...(answers !== undefined ? { user_message_uuid: answers } : {}),
  } as unknown as SDKMessage;
}

/**
 * The shape `SDKResultError` really has: no `user_message_uuid` field at all.
 * Every failed turn arrives looking like this.
 */
function errorResultMessage(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['the model gave up'],
    uuid: 'result-error',
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/** The model saying something — the content a window is supposed to carry. */
function textDeltaMessage(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

/**
 * The SDK's retry notice — what the CLI emits when a continuation's FIRST
 * request is rate-limited or overloaded and it is about to back off. Not
 * content, and it arrives ahead of the continuation's first word.
 */
function apiRetryMessage(retryDelayMs: number): SDKMessage {
  return {
    type: 'system',
    subtype: 'api_retry',
    attempt: 1,
    max_retries: 3,
    retry_delay_ms: retryDelayMs,
    error_status: 529,
    session_id: 'sdk-1',
    uuid: 'api-retry-1',
  } as unknown as SDKMessage;
}

/** The SDK's compaction boundary, snake_case as it arrives on the stream. */
function compactBoundaryMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 38234, post_tokens: 3035, duration_ms: 19707 },
    session_id: 'sdk-1',
    uuid: 'boundary-auto',
  } as unknown as SDKMessage;
}

/** One window's slice of the durable stream, `turn_start` through `turn_end`. */
interface ProjectedWindow {
  /** `turn_start.origin` — absent for the ordinary case, `'runtime'` for a window nobody asked for. */
  origin: string | undefined;
  types: string[];
  events: SessionEvent[];
}

interface Harness {
  pump: SessionPump;
  windows: SessionTurnWindows;
  queries: FakeQuery[];
  live: () => FakeQuery;
  /** Every window the windower opened, in order. */
  opened: TurnWindow[];
  /** Every window whose close fully settled, in order. */
  closedWindows: TurnWindow[];
  /** Every window's projection promise, resolved when its stream ends. */
  projected: Promise<void>[];
  usages: WindowUsage[];
  /** Every SDK message the pump handed to the windower, in order. */
  seen: SDKMessage[];
  /**
   * The StreamEvents each window produced, in window order. `context_usage` has
   * no durable projection — it rides the StreamEvent stream — so its ordering
   * against `done` can only be read here.
   */
  streamEvents: StreamEvent[][];
  /** The durable stream so far, grouped into windows. */
  windowsOnStream: () => ProjectedWindow[];
  /** The durable stream so far, ungrouped. */
  rawStream: () => SessionEvent[];
  /** Boot the process and open the first window with `messageId`. */
  dispatch: (batch: Array<{ content: string; messageId: string }>) => Promise<TurnWindow>;
}

/**
 * A pump, a windower, and a projector, wired exactly as the runtime will wire
 * them: every window that opens is immediately mapped and fed to the projector,
 * and the accounting seam lands on the session the mapper reads — which is what
 * makes `context_usage` precede `done`.
 */
function harness(
  hooks: {
    onWindowClose?: (window: TurnWindow) => void;
    graceMs?: number;
    capMs?: number;
  } = {}
): Harness {
  const queries: FakeQuery[] = [];
  const opened: TurnWindow[] = [];
  const closedWindows: TurnWindow[] = [];
  const projected: Promise<void>[] = [];
  const usages: WindowUsage[] = [];
  const seen: SDKMessage[] = [];
  const streamEvents: StreamEvent[][] = [];
  const projector = new SessionStateProjector(SESSION_ID);
  const session = {} as AgentSession;
  const toolState = createToolState();

  // The pump's observers call back into the windower, which needs the pump to
  // exist first. One holder breaks the cycle without a mutable binding.
  const ref: { windows?: SessionTurnWindows } = {};
  const pump = new SessionPump({
    sessionId: SESSION_ID,
    launch: () => {
      const query = new FakeQuery();
      queries.push(query);
      return query;
    },
    onMessage: (message) => {
      seen.push(message);
      ref.windows?.onMessage(message);
    },
    onCrash: (crash) => ref.windows?.onCrash(crash),
    drainGraceMs: 20,
  });

  const project = async (window: TurnWindow): Promise<void> => {
    const mine: StreamEvent[] = [];
    streamEvents.push(mine);
    async function* stream(): AsyncIterable<StreamEvent> {
      for await (const message of window.messages) {
        for await (const event of mapSdkMessage(message, session, SESSION_ID, toolState)) {
          mine.push(event);
          yield event;
        }
      }
    }
    await feedProjector(projector, stream(), {
      ...(window.origin === 'runtime'
        ? { origin: 'runtime' as const }
        : { userMessage: 'do the thing' }),
    });
  };

  const windows = new SessionTurnWindows({
    sessionId: SESSION_ID,
    pump,
    usageTimeoutMs: 500,
    // Injected so the steer-continuation cases are decided by the code under
    // test rather than by a real-time sleep racing the assertions. A LONG grace
    // is the sharper instrument in most of them: a window that must close at
    // once hangs the test if it starts waiting.
    ...(hooks.graceMs !== undefined ? { continuationGraceMs: hooks.graceMs } : {}),
    ...(hooks.capMs !== undefined ? { continuationCapMs: hooks.capMs } : {}),
    onWindowOpen: (window) => {
      opened.push(window);
      projected.push(project(window));
    },
    onWindowClose: (window) => {
      closedWindows.push(window);
      // Recorded BEFORE the hook, so a hook that throws still leaves the
      // bookkeeping a test needs to reason about what happened.
      hooks.onWindowClose?.(window);
    },
    // Exactly what `message-sender` does with the same two fetches today.
    onUsage: (usage) => {
      usages.push(usage);
      if (usage.context) session.contextBreakdown = usage.context;
      if (usage.subscription) session.lastSubscriptionUsage = usage.subscription;
    },
  });

  ref.windows = windows;

  return {
    pump,
    windows,
    queries,
    opened,
    closedWindows,
    projected,
    usages,
    seen,
    streamEvents,
    live: () => queries[queries.length - 1]!,
    windowsOnStream: () => groupWindows(projector.replayFrom(0)),
    rawStream: () => projector.replayFrom(0),
    dispatch: async (batch) => {
      const dispatching = windows.dispatch(batch, CWD);
      // The launch parks until the CLI reports itself ready; only the first
      // dispatch boots a process, so a later one has nothing to wait for.
      if (queries.length === 0) {
        await vi.waitFor(() => expect(queries.length).toBe(1));
        queries[0]!.emit(initMessage());
      }
      return dispatching;
    },
  };
}

/**
 * Report whether `work` has settled by the next macrotask.
 *
 * The microtask queue drains completely before any macrotask runs, so anything
 * that was going to resolve without further real work has already done so by the
 * time this answers — which makes `'pending'` a claim about the code under test
 * rather than about timing luck.
 *
 * @param work - The promise being probed.
 */
function settledOrPending(work: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    work.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

/** Cut the durable stream into windows at its `turn_start`/`turn_end` pairs. */
function groupWindows(events: SessionEvent[]): ProjectedWindow[] {
  const out: ProjectedWindow[] = [];
  let open: ProjectedWindow | undefined;
  for (const event of events) {
    if (event.type === 'turn_start') {
      open = {
        origin: (event as { origin?: string }).origin,
        types: [],
        events: [],
      };
      out.push(open);
    }
    if (open === undefined) continue;
    open.types.push(event.type);
    open.events.push(event);
    if (event.type === 'turn_end') open = undefined;
  }
  return out;
}

/**
 * Let every window through to its end.
 *
 * `windows` is the number expected to have opened by now, and waiting for it is
 * load-bearing: a window the pump has not delivered a message for yet is not in
 * `projected`, so draining without the wait would resolve instantly and assert
 * against a stream that has not happened.
 */
async function settled(h: Harness, windows: number): Promise<void> {
  await vi.waitFor(() => expect(h.opened.length).toBe(windows));
  await Promise.all(h.projected);
}

describe('SessionTurnWindows — a turn opens on dispatch and closes on its result', () => {
  // AC1. Three dispatches through ONE pump. The whole point of the layer: the
  // process outlives the turn, so the stream has to carry three DISCRETE turns
  // rather than one long one.
  it('cuts three dispatches into three turn_start/turn_end pairs, in order', async () => {
    const h = harness();

    for (const [index, id] of ['m1', 'm2', 'm3'].entries()) {
      await h.dispatch([{ content: `say ${id}`, messageId: id }]);
      h.live().emit(textDeltaMessage(`answer to ${id}`));
      h.live().emit(resultMessage(id));
      await settled(h, index + 1);
    }

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(3);
    // No overlap: every window is a complete start..end run of its own.
    for (const window of windows) {
      expect(window.types[0]).toBe('turn_start');
      expect(window.types[window.types.length - 1]).toBe('turn_end');
      expect(window.types.filter((t) => t === 'turn_start')).toHaveLength(1);
      expect(window.types.filter((t) => t === 'turn_end')).toHaveLength(1);
    }
    // Each window carried its own answer, in dispatch order.
    expect(
      windows.map(
        (w) => w.events.find((e) => e.type === 'text_delta') as { text?: string } | undefined
      )
    ).toEqual([
      expect.objectContaining({ text: 'answer to m1' }),
      expect.objectContaining({ text: 'answer to m2' }),
      expect.objectContaining({ text: 'answer to m3' }),
    ]);
    // One process for all three — the reason any of this exists.
    expect(h.queries).toHaveLength(1);
  });

  // AC2. The coalescing case. Two rows dequeued together are ONE turn with TWO
  // correlation ids, and the single `result` has to close all of them — the
  // failure being prevented is a window nothing can ever close.
  it('closes every id in a coalesced batch on the one result that answers it', async () => {
    const h = harness();

    const window = await h.dispatch([
      { content: 'first', messageId: 'm1' },
      { content: 'second', messageId: 'm2' },
    ]);
    expect(window.ids).toEqual(['m1', 'm2']);

    // The SDK names ONE of the batch on the result it coalesced them into.
    h.live().emit(resultMessage('m2'));
    await settled(h, 1);

    expect(h.windowsOnStream()).toHaveLength(1);
    expect(h.windowsOnStream()[0]!.types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(h.pump.state).toBe('warm');
    // Both messages really were sent, in order, as one turn's input.
    expect(h.windows.openWindow).toBeUndefined();
  });

  // The mutation this correlation exists to survive: a result naming a message
  // this session never sent is NOT this window's result. Closing on it would
  // end a turn that is still running and hand the person a half-turn.
  it('does NOT close the open window on a result naming an id nobody dispatched', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    h.live().emit(resultMessage('m-somebody-elses'));
    await vi.waitFor(() => expect(h.opened.length).toBe(2));
    await h.projected[1];

    // The dispatched window is still open and still the one a result would close.
    expect(h.windows.openWindow?.ids).toEqual(['m1']);
    expect(h.pump.state).toBe('running');

    // And it closes properly when its OWN result finally arrives.
    h.live().emit(resultMessage('m1'));
    await settled(h, 2);
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
  });

  // AC3. Nobody asked for this turn. It must reach the stream — the durable
  // stream is a complete account of the session — without being dressed up as a
  // person's turn.
  it('gives a result that answers no dispatch its own runtime-origin turn', async () => {
    const h = harness();

    await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
    h.live().emit(resultMessage('m1'));
    await settled(h, 1);

    // The CLI starts a continuation DorkOS never asked for.
    h.live().emit(textDeltaMessage('a background task just finished'));
    h.live().emit(resultMessage('never-dispatched'));
    await settled(h, 2);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(2);
    expect(windows[0]!.origin).toBeUndefined();
    expect(windows[1]!.origin).toBe('runtime');
    // The words that led to it ride INSIDE it rather than being dropped.
    expect(windows[1]!.events).toContainEqual(
      expect.objectContaining({ type: 'text_delta', text: 'a background task just finished' })
    );
    expect(h.opened[1]!.ids).toEqual([]);
  });

  // Reality beating the spec's phrasing: `SDKResultError` declares no
  // `user_message_uuid`, so every FAILED turn arrives unnamed. Treating it as
  // uncorrelated would strand the open window on exactly the turns that went
  // wrong.
  it('closes the open window on an unnamed result, because error results carry no id', async () => {
    const h = harness();

    await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
    h.live().emit(errorResultMessage());
    await settled(h, 1);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    const end = windows[0]!.events.find((e) => e.type === 'turn_end');
    expect(end).toMatchObject({ terminalReason: 'error' });
    expect(h.pump.state).toBe('warm');
  });

  // AC4. The fetch that used to happen once, at the one result that ended the
  // process, now happens at EVERY window close — and still lands ahead of
  // `done`, which is the only reason the client ever sees it.
  it('emits context_usage before done in every window, not just the first', async () => {
    const h = harness();

    for (const [index, id] of ['m1', 'm2', 'm3'].entries()) {
      await h.dispatch([{ content: `say ${id}`, messageId: id }]);
      h.live().emit(resultMessage(id));
      await settled(h, index + 1);
    }

    expect(h.windowsOnStream()).toHaveLength(3);
    expect(h.streamEvents).toHaveLength(3);
    for (const events of h.streamEvents) {
      const types = events.map((e) => e.type);
      const usageAt = types.indexOf('context_usage');
      expect(usageAt).toBeGreaterThanOrEqual(0);
      expect(usageAt).toBeLessThan(types.indexOf('done'));
    }
    // Each window's breakdown is its OWN, not the one before it left behind:
    // the fake reports a different total on every control call.
    expect(
      h.streamEvents.map(
        (events) =>
          (events.find((e) => e.type === 'context_usage')?.data as { totalTokens?: number })
            .totalTokens
      )
    ).toEqual([1_000, 2_000, 3_000]);
    // The subscription half of the same per-window fetch, which is what keeps
    // the Usage & cost item from flickering back to cost-only between turns.
    expect(h.usages).toHaveLength(3);
    for (const usage of h.usages) {
      expect(usage.subscription).toMatchObject({ kind: 'subscription', utilization: 0.25 });
    }
  });

  // AC5. WARM is the whole point: the process survives its turn, and it is
  // still a process — it answers.
  it('leaves the subprocess warm and answering control calls after a window closes', async () => {
    const h = harness();

    await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
    h.live().emit(resultMessage('m1'));
    await settled(h, 1);

    expect(h.pump.warmth).toBe('warm');
    expect(h.queries).toHaveLength(1);
    expect(h.live().closed).toBe(0);
    const control = h.pump.controlQuery;
    expect(control).toBeDefined();
    await expect(control!.getContextUsage()).resolves.toMatchObject({ model: 'test-model' });
  });

  // AC6. The process dies mid-turn. The window must settle as a failure, and
  // exactly once — a second terminal would double-settle the lifecycle.
  it('closes the open window with one turn_end{error} when the process dies mid-window', async () => {
    const h = harness();

    await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
    h.live().emit(textDeltaMessage('working on it'));
    h.live().failStream(new Error('the CLI died'));
    await settled(h, 1);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(windows[0]!.events.find((e) => e.type === 'turn_end')).toMatchObject({
      terminalReason: 'error',
    });
    expect(h.pump.state).toBe('crashed');
    expect(h.windows.openWindow).toBeUndefined();
  });

  // This used to refuse the second dispatch with an IllegalPumpTransitionError,
  // and that refusal is what made DOR-1294 permanent: a window whose `result`
  // went elsewhere stayed open, so EVERY later dispatch threw and the session
  // was dead until the server restarted. A dispatch reaching this ingress holds
  // the per-session mutex for the previous turn's whole stream, so a window
  // still open under it is stranded — it gets a terminal, and the turn nobody
  // could run runs.
  it('abandons a stranded window instead of refusing the next dispatch', async () => {
    const h = harness();

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    // The second dispatch is accepted, and the stranded turn is settled.
    await expect(
      h.windows.dispatch([{ content: 'second', messageId: 'm2' }], CWD)
    ).resolves.toMatchObject({ ids: ['m2'] });

    h.live().emit(resultMessage('m2'));
    await settled(h, 2);

    // Counted on the raw stream: the abandoned window's projection lags the new
    // window's `turn_start`, so the two interleave exactly as the concurrent
    // closes above do. Two turns, two terminals, and the stranded one ended as a
    // failure rather than streaming forever.
    const raw = h.rawStream();
    const types = raw.map((e) => e.type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(2);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(2);
    expect(raw.filter((e) => e.type === 'turn_end')).toContainEqual(
      expect.objectContaining({ terminalReason: 'error' })
    );
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
  });

  // The same abandonment, reachable BEFORE a successor exists (DOR-1295). The
  // composer calls this ahead of minting the next turn's `turn_start`, so the
  // stranded turn's terminal cannot land inside a healthy turn's window. Its
  // ANSWER is what gates the composer's wait, so both answers are pinned: a
  // method that said `true` unconditionally would make every ordinary turn wait
  // for a terminal that is never coming.
  it('settles the open window on demand, and says so only when there was one', async () => {
    const h = harness();

    // Nothing open: nothing to settle, and nothing invented.
    expect(h.windows.abandonOpenWindow()).toBe(false);
    expect(h.opened).toHaveLength(0);

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    expect(h.windows.abandonOpenWindow()).toBe(true);
    await settled(h, 1);

    // One turn, ended as the failure it is, with no dispatch involved.
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.events.find((e) => e.type === 'turn_end')).toMatchObject({
      terminalReason: 'error',
    });
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
    // And it is idempotent: the window it settled is gone.
    expect(h.windows.abandonOpenWindow()).toBe(false);
  });

  // An empty batch would move the pump to RUNNING with nothing sent: a window
  // no result could ever close.
  it('refuses an empty batch', async () => {
    const h = harness();
    await expect(h.windows.dispatch([], CWD)).rejects.toMatchObject({ reason: 'empty-dispatch' });
    expect(h.opened).toHaveLength(0);
  });

  // A refused dispatch must be INVISIBLE. `onWindowOpen` is where task 3.10
  // projects the window, and the `turn_start` that mints is what retires the
  // caller's queue row — and the dispatcher restores only rows still IN the
  // store (`returnToQueue`), so a row retired for a turn that never ran is a
  // message silently lost. Announcing the window before the pump has accepted
  // the batch is exactly that bug, and it also puts an empty turn on the
  // durable stream.
  it('announces no window at all when the pump refuses the dispatch', async () => {
    const opened: TurnWindow[] = [];
    const closed: TurnWindow[] = [];
    const refusing = new SessionTurnWindows({
      sessionId: SESSION_ID,
      pump: {
        dispatch: () =>
          Promise.reject(new PumpRefusedError('warm-ceiling', 'no slot for this session')),
        endTurn: () => {},
        controlQuery: undefined,
      },
      onWindowOpen: (w) => opened.push(w),
      onWindowClose: (w) => closed.push(w),
    });

    await expect(
      refusing.dispatch([{ content: 'do the thing', messageId: 'm1' }], CWD)
    ).rejects.toBeInstanceOf(PumpRefusedError);

    // Nobody was ever told a turn started, so nobody retired the queue row.
    expect(opened).toHaveLength(0);
    // And nothing is told a window it never saw has closed.
    expect(closed).toHaveLength(0);
    expect(refusing.openWindow).toBeUndefined();
  });

  // The other half of the same teardown: output the process managed to produce
  // before the refusal belongs to no window, so it waits for the next one
  // rather than dying in a stream nobody will read.
  it("re-holds an abandoned window's messages for the next window", async () => {
    const opened: TurnWindow[] = [];
    let refuse = true;
    const windows = new SessionTurnWindows({
      sessionId: SESSION_ID,
      pump: {
        dispatch: () =>
          refuse
            ? Promise.reject(new PumpRefusedError('warm-ceiling', 'no slot'))
            : Promise.resolve(),
        endTurn: () => {},
        controlQuery: undefined,
      },
      onWindowOpen: (w) => opened.push(w),
    });

    // The warm process speaks with no window open: held.
    windows.onMessage(textDeltaMessage('said before the refusal'));

    await expect(
      windows.dispatch([{ content: 'never runs', messageId: 'm-refused' }], CWD)
    ).rejects.toBeInstanceOf(PumpRefusedError);
    expect(opened).toHaveLength(0);

    // The next dispatch is accepted, and the held words ride into ITS window.
    refuse = false;
    const window = await windows.dispatch([{ content: 'hello', messageId: 'm1' }], CWD);
    expect(opened).toHaveLength(1);

    const got: SDKMessage[] = [];
    const reading = (async () => {
      for await (const m of window.messages) got.push(m);
    })();
    windows.onMessage(resultMessage('m1'));
    await reading;

    // In order: the re-held message first, then this window's own result.
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ type: 'stream_event' });
    expect(got[1]).toMatchObject({ type: 'result' });
  });

  // Nothing the process says is lost. A message that arrives between windows is
  // held and rides into the next one.
  it('flushes messages that arrived with no window open into the next window', async () => {
    const h = harness();

    // Warm without dispatching: the init arrives with no window open.
    const warming = h.pump.warm();
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    h.live().emit(initMessage());
    await warming;
    expect(h.opened).toHaveLength(0);

    h.live().emit(textDeltaMessage('unprompted'));
    // Wait for the pump to have HANDED it over before dispatching, or the race
    // decides whether it was held or simply arrived inside the new window —
    // and the test would then pass whether or not held messages survive.
    await vi.waitFor(() => expect(h.seen).toHaveLength(2));
    await h.windows.dispatch([{ content: 'hello', messageId: 'm1' }], CWD);
    h.live().emit(resultMessage('m1'));
    await settled(h, 1);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.events).toContainEqual(
      expect.objectContaining({ type: 'text_delta', text: 'unprompted' })
    );
  });

  // TWO closes in flight at once, which every other case in this file rules out
  // by settling between results. The pump's read loop is synchronous, so a stray
  // result and the real one land back to back, both before either close's
  // accounting has come back — and a dispatch may not start until BOTH have
  // finished, `pump.endTurn()` included. Parking the control answers is what
  // makes the interleaving the test's choice rather than the timer queue's.
  it('makes a dispatch wait for EVERY in-flight close, not just the newest', async () => {
    const h = harness();
    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    h.live().holdControls = true;

    // Two closes, back to back, exactly as the read loop would deliver them:
    // a runtime window for the stray, then window A's own close.
    h.live().emit(resultMessage('m-somebody-elses'));
    await vi.waitFor(() => expect(h.opened).toHaveLength(2));
    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.live().parkedControls).toBe(4));

    // Let ONLY the runtime window's accounting through. Window A's close is
    // still in flight, so the pump is still RUNNING and its turn is not over.
    h.live().releaseControls(2);
    // Wait for that close to be FULLY settled — observed, and its bookkeeping
    // done — not merely for its answers to be handed over. The single-field
    // overwrite only bites once the finished close has cleared the field the
    // unfinished one is parked in.
    await vi.waitFor(() => expect(h.closedWindows).toHaveLength(1));
    expect(h.live().parkedControls).toBe(2);
    expect(h.pump.state).toBe('running');

    // The next turn must be accepted, not refused because a close it could not
    // see had not reached `endTurn()` yet.
    const dispatching = h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD);
    // Released on a LATER MACROTASK, and that boundary is the whole experiment.
    // Node drains every microtask first, so a windower that believes nothing is
    // closing gets all the way to `pump.dispatch` before this line runs — and a
    // pump still RUNNING refuses it with IllegalPumpTransitionError. A windower
    // that waits for every in-flight close is still parked here, and proceeds
    // once this lets window A finish. Releasing synchronously instead would let
    // A's `endTurn()` win the race often enough to look green.
    setTimeout(() => h.live().releaseControls(), 0);
    await expect(dispatching).resolves.toMatchObject({ ids: ['m2'] });
    expect(h.pump.state).toBe('running');

    h.live().emit(resultMessage('m2'));
    await settled(h, 3);

    // Three windows, three closes, none of them doubled.
    //
    // Counted on the raw stream rather than grouped into contiguous windows,
    // because here two windows were genuinely open AT ONCE — the runtime window
    // for the stray result, and window A — so their events interleave on the one
    // projector, and A's `turn_end` lands after m2's `turn_start`. That is the
    // per-window projection lagging, not a window staying open: the windower had
    // already ended A's stream and the pump's turn before m2 was dispatched,
    // which is the very thing this test made it wait for. Ordering the projector
    // sees is the wiring task's (3.10) business; the windower promises the
    // boundaries, and exactly one close per window is the boundary claim.
    const types = h.rawStream().map((e) => e.type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(3);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(3);
  });

  // The other half of that invariant: the set of in-flight closes is not a
  // snapshot taken once. The process keeps talking while a dispatch waits, so a
  // stray `result` can open and close a whole runtime window in that gap — and
  // that close has to be waited for too, or the dispatch resumes into it.
  it('keeps waiting for a close that appears while it is already waiting', async () => {
    const h = harness();
    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    h.live().holdControls = true;

    // Window A's close starts and parks on its accounting.
    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.live().parkedControls).toBe(2));

    const dispatching = h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD);

    // Mid-wait, the process answers something nobody sent: a second close, and
    // one this dispatch could not have known about when it started waiting.
    h.live().emit(resultMessage('m-somebody-elses'));
    await vi.waitFor(() => expect(h.opened).toHaveLength(2));
    await vi.waitFor(() => expect(h.live().parkedControls).toBe(4));

    // Let ONLY window A's close finish. The pump is warm again, so a dispatch
    // that had waited for just that one would sail on from here.
    h.live().releaseControls(2);
    await vi.waitFor(() => expect(h.closedWindows).toHaveLength(1));
    expect(h.pump.state).toBe('warm');
    await expect(settledOrPending(dispatching)).resolves.toBe('pending');

    // Only once the late close is done too may the turn begin.
    h.live().releaseControls();
    await expect(dispatching).resolves.toMatchObject({ ids: ['m2'] });

    h.live().emit(resultMessage('m2'));
    await settled(h, 3);
    const types = h.rawStream().map((e) => e.type);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(3);
  });

  // A close that throws is contained where it happens. Letting it reject would
  // leave a poisoned promise among the in-flight closes, and the NEXT dispatch —
  // which waits on all of them — would fail with an error belonging to a turn
  // that was not even its own.
  it('contains a throwing close instead of failing the next dispatch with it', async () => {
    const h = harness({
      onWindowClose: () => {
        throw new Error('a window observer exploded');
      },
    });
    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    h.live().holdControls = true;

    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.live().parkedControls).toBe(2));

    // The dispatch starts waiting while that doomed close is still in flight.
    const dispatching = h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD);
    setTimeout(() => h.live().releaseControls(), 0);

    await expect(dispatching).resolves.toMatchObject({ ids: ['m2'] });
    // The throw did not rob the window of its close: the pump's turn ended, and
    // the observer really was called.
    expect(h.closedWindows).toHaveLength(1);
    expect(h.pump.state).toBe('running');
  });
});

describe('SessionTurnWindows — a steer joins the open window (task 4.1)', () => {
  // AC1 + AC4. A steer pushes a second user message into the running turn, which
  // the CLI coalesces into the SAME turn and answers with ONE result naming the
  // steer. Unless the open window has learned the steer's id, that result reads
  // as one this session never sent — a synthetic second turn on the stream, and
  // the real turn stranded open. Revert `steerOpenWindow` and this window count
  // goes to two: the red-first proof.
  it('keeps a steered turn to exactly one turn_start and one turn_end', async () => {
    const h = harness();

    const window = await h.dispatch([{ content: 'do the thing', messageId: 'm-open' }]);
    h.live().emit(textDeltaMessage('starting'));

    expect(h.windows.steerOpenWindow('m-steer')).toBe(true);
    // The id joined the open window's live array.
    expect(window.ids).toEqual(['m-open', 'm-steer']);

    // ONE result, naming the steer (the last message the CLI read).
    h.live().emit(resultMessage('m-steer'));
    await settled(h, 1);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.filter((t) => t === 'turn_start')).toHaveLength(1);
    expect(windows[0]!.types.filter((t) => t === 'turn_end')).toHaveLength(1);
  });

  // A steer arriving after the turn has closed has nothing to join. The caller
  // reads this to report `no-open-turn` rather than silently correlating a
  // closed window.
  it('returns false when no window is open', () => {
    const h = harness();
    expect(h.windows.steerOpenWindow('m-steer')).toBe(false);
  });
});

describe('SessionTurnWindows — a late result cannot strand the open window (DOR-1294)', () => {
  // The sequence the P5.1 measurement caught live, one arm-B run in three
  // (`research/20260817_persistent-session-flag-measurement.md` §6):
  //
  //   turn 3 dispatched, steered mid-turn, and answered by a `result` naming the
  //   TURN — so the steer stayed in the CLI's queue and its window closed
  //   without it. Turn 4 was then dispatched, and the CLI answered the steer
  //   (coalesced with turn 4) under ONE `result` naming the steer.
  //
  // Correlating only against the OPEN window read that last `result` as a
  // message this session never sent, gave it a runtime window, and left turn 4's
  // window with nothing that could ever close it — after which every dispatch
  // threw `IllegalPumpTransitionError` and the session was dead until restart.
  //
  // Revert the `awaitingResult` ledger and this goes red at the first assertion:
  // turn 4's window is still open, and the dispatch below throws.
  it('closes the open window on a result naming a steer an earlier window sent', async () => {
    const h = harness();

    // Turn 3: dispatched, steered, and answered by the TURN's own id.
    await h.dispatch([{ content: 'do the thing', messageId: 'm-turn3' }]);
    expect(h.windows.steerOpenWindow('m-steer')).toBe(true);
    h.live().emit(resultMessage('m-turn3'));
    await settled(h, 1);

    // Turn 4: dispatched while the steer is still sitting in the CLI's queue.
    await h.windows.dispatch([{ content: 'and now this', messageId: 'm-turn4' }], CWD);
    expect(h.windows.openWindow?.ids).toEqual(['m-turn4']);

    // The CLI answers the queued steer, coalesced with turn 4, under one result.
    h.live().emit(resultMessage('m-steer'));
    await settled(h, 2);

    // Turn 4's window closed on it rather than waiting forever.
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');

    // And the session still works: turn 5 runs, on the same process.
    await h.windows.dispatch([{ content: 'turn five', messageId: 'm-turn5' }], CWD);
    h.live().emit(resultMessage('m-turn5'));
    await settled(h, 3);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(3);
    for (const window of windows) {
      expect(window.types.filter((t) => t === 'turn_start')).toHaveLength(1);
      expect(window.types.filter((t) => t === 'turn_end')).toHaveLength(1);
      // Every turn ended normally — nothing was abandoned by the backstop.
      expect(window.events.find((e) => e.type === 'turn_end')).not.toMatchObject({
        terminalReason: 'error',
      });
    }
    expect(h.queries).toHaveLength(1);
  });

  // The ledger is a memory of what was SENT, not of every id ever seen: an id
  // nobody sent is still a turn of the CLI's own, and it must not close a
  // person's window. This is the guard the `sentEarlier` branch must not swallow
  // — the same claim as the "nobody dispatched" case above, restated after a
  // steer so a fix that simply closed on every unmatched id goes red here.
  it('still leaves the open window alone for an id nothing ever sent', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('m-steer')).toBe(true);
    h.live().emit(resultMessage('m1'));
    await settled(h, 1);

    await h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD);
    h.live().emit(resultMessage('m-nobody-ever-sent-this'));
    await vi.waitFor(() => expect(h.opened.length).toBe(3));

    expect(h.windows.openWindow?.ids).toEqual(['m2']);
    expect(h.pump.state).toBe('running');
  });

  // The backstop, on the one path the ledger cannot reach: a window whose result
  // never arrives at all. A session that can never dispatch again is the worst
  // failure this layer has, so the next dispatch settles the stranded turn
  // instead of inheriting its wedge.
  it('recovers when an unattributable result leaves a window with no result of its own', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    // A result for a turn nobody asked for: its own runtime window, and m1's
    // window is deliberately left open (the case above).
    h.live().emit(resultMessage('m-nobody-ever-sent-this'));
    await vi.waitFor(() => expect(h.opened.length).toBe(2));
    expect(h.windows.openWindow?.ids).toEqual(['m1']);

    // m1's own result never comes. The next message must still run.
    await expect(
      h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD)
    ).resolves.toMatchObject({ ids: ['m2'] });
    h.live().emit(resultMessage('m2'));
    await settled(h, 3);

    const types = h.rawStream().map((e) => e.type);
    expect(types.filter((t) => t === 'turn_start')).toHaveLength(3);
    expect(types.filter((t) => t === 'turn_end')).toHaveLength(3);
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
  });

  // The same shape reached through the other P4 verb. A staged message opens no
  // window (`shouldQuery: false` runs no turn), and the CLI merges it into the
  // next querying message — whose `result` may name the STAGED id. Without the
  // ledger entry that is a `result` naming an id the windower never heard of,
  // which is the DOR-1294 shape again.
  it('closes the open window on a result naming a staged message', async () => {
    const h = harness();

    // Staged onto a warm process, with no window open at all.
    h.windows.noteStagedMessage('m-staged');
    await h.dispatch([{ content: 'now answer', messageId: 'm1' }]);

    h.live().emit(resultMessage('m-staged'));
    await settled(h, 1);

    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
    expect(h.windowsOnStream()).toHaveLength(1);
  });

  // The ledger has to be given up on the same terms the window is. An abandoned
  // turn's ids are DorkOS's declaration that the turn is over, so the late
  // `result` the backstop was compensating for must not then be read as evidence
  // about the successor — which is the `sentEarlier` branch closing the wrong
  // window all over again, one turn further along. Drop the `delete` loop in
  // `abandonStranded` and this goes red.
  it('does not let an abandoned turn’s late result close the successor’s window', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the one that hangs', messageId: 'm1' }]);
    // m1's result never comes; the next dispatch abandons its window.
    await h.windows.dispatch([{ content: 'next', messageId: 'm2' }], CWD);
    expect(h.windows.openWindow?.ids).toEqual(['m2']);

    // The process finally answers m1, long after DorkOS gave up on it.
    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.opened.length).toBe(3));

    // m2's turn is untouched, and closes on its OWN result.
    expect(h.windows.openWindow?.ids).toEqual(['m2']);
    h.live().emit(resultMessage('m2'));
    await settled(h, 3);
    expect(h.windows.openWindow).toBeUndefined();
    expect(h.pump.state).toBe('warm');
  });

  // The DOR-1187 fast turn: the whole turn is answered while `dispatch` is still
  // awaiting the pump, so the window closes before the ids are ever filed. They
  // must NOT be filed afterwards — the process has already spoken for them, and
  // a spent id in the ledger is a loaded gun pointed at the next window.
  it('does not file ids the process answered before the dispatch returned', async () => {
    const closed: TurnWindow[] = [];
    // The pump's dispatch calls back into the windower, which needs the pump
    // first — the same holder the harness above uses to break the cycle.
    const ref: { windows?: SessionTurnWindows } = {};
    const windows = new SessionTurnWindows({
      sessionId: SESSION_ID,
      pump: {
        // The result lands INSIDE the dispatch, exactly as a turn answered
        // during the launch does.
        dispatch: (batch) => {
          if (batch[0]!.messageId === 'm-fast') ref.windows!.onMessage(resultMessage('m-fast'));
          return Promise.resolve();
        },
        endTurn: () => {},
        controlQuery: undefined,
      },
      onWindowOpen: (w) =>
        void (async () => {
          for await (const _m of w.messages) void _m;
        })(),
      onWindowClose: (w) => closed.push(w),
    });
    ref.windows = windows;

    await windows.dispatch([{ content: 'answered instantly', messageId: 'm-fast' }], CWD);
    await vi.waitFor(() => expect(closed).toHaveLength(1));
    expect(windows.openWindow).toBeUndefined();

    // The next turn, and a duplicate of the spent result behind it.
    await windows.dispatch([{ content: 'the real next turn', messageId: 'm2' }], CWD);
    windows.onMessage(resultMessage('m-fast'));

    // Untouched: an id the process already answered says nothing about this
    // window. Without the `this.current === record` guard it closes it.
    expect(windows.openWindow?.ids).toEqual(['m2']);
  });

  // A crash empties the ledger: the process that owed those answers is gone, and
  // a `result` from a RELAUNCHED process under an old id is not evidence about
  // the new process's turn. Same reasoning as the held buffer's `onCrash` drop.
  it('forgets sent ids when the process dies', async () => {
    const h = harness();

    await h.dispatch([{ content: 'the real one', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('m-steer')).toBe(true);
    h.live().failStream(new Error('the CLI died'));
    await settled(h, 1);
    expect(h.pump.state).toBe('crashed');

    // The relaunch, and a stray result under the dead process's steer id.
    const dispatching = h.windows.dispatch([{ content: 'after the crash', messageId: 'm2' }], CWD);
    await vi.waitFor(() => expect(h.queries.length).toBe(2));
    h.live().emit(initMessage());
    await dispatching;

    h.live().emit(resultMessage('m-steer'));
    await vi.waitFor(() => expect(h.opened.length).toBe(3));

    // Untouched: the new process never read that id, so it says nothing about
    // the turn it is running now.
    expect(h.windows.openWindow?.ids).toEqual(['m2']);
  });
});

describe('a steered window waits for the continuation, and only for that (DOR-1314)', () => {
  /**
   * Open a window, steer into it, and let the CLI end the turn naming the
   * DISPATCHED message — the state every case below starts from. The steer is
   * still in the CLI's queue, so this window may not close yet.
   *
   * Nothing is awaited between the emits: the pump delivers them to the
   * windower in order, so a case that needs a message to land INSIDE the grace
   * passes it here rather than racing the clock with a poll.
   *
   * @param h - The harness driving it
   * @param inBurst - Messages to emit immediately behind the closing `result`,
   *   i.e. inside the grace it opens
   */
  async function steeredAndAnswered(h: Harness, inBurst: SDKMessage[] = []): Promise<void> {
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
    h.live().emit(textDeltaMessage('the first answer'));
    h.live().emit(resultMessage('m1'));
    for (const message of inBurst) h.live().emit(message);
  }

  /** Wait until the windower has been handed the `result` that opens the grace. */
  async function graceIsOpen(h: Harness): Promise<void> {
    await vi.waitFor(() => expect(h.seen.some((m) => m.type === 'result')).toBe(true));
  }

  it('is not closed by bookkeeping, and still has a real terminal after it', async () => {
    // The `system/init` an explicit warm produces, arriving inside the grace,
    // and then silence. Routine traffic, not a turn — so the clock must not
    // stop, and even if it did the window must still hold a real terminal.
    // Clearing the deferred `result` alongside the timer left it holding
    // nothing, and the window never closed at all: this hangs on that.
    const h = harness({ graceMs: 60, capMs: 150 });
    await steeredAndAnswered(h, [initMessage()]);

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.at(-1)).toBe('turn_end');
    // Closed on the CLI's own successful `result`, never on the synthetic
    // "the agent never finished this turn".
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });

  it('does not cut short a continuation that outlasts the grace', async () => {
    // The wait is for the continuation to BEGIN, never for it to finish. A
    // 60ms grace against 200ms of work makes that the only reading that
    // passes: stopping the clock on the first word is what saves the rest.
    const h = harness({ graceMs: 60 });
    await steeredAndAnswered(h, [textDeltaMessage('starting on the tests')]);

    await new Promise((resolve) => setTimeout(resolve, 200));
    h.live().emit(textDeltaMessage('and here is what they say'));
    h.live().emit(resultMessage('steer-1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'and here is what they say'
      )
    ).toBe(true);
  });

  it('survives an api_retry announced ahead of the continuation', async () => {
    // Probe D, exactly: a 40ms clock, an `api_retry` inside it, and the
    // continuation's first word 150ms later. The retry is not content, so it
    // cannot stop the clock — but it is proof the process is alive, so it buys
    // another grace. Ignoring it let the clock run out and the whole
    // continuation went into a runtime window nothing projects.
    const h = harness({ graceMs: 40 });
    await steeredAndAnswered(h, [apiRetryMessage(150)]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    h.live().emit(textDeltaMessage('answering after the retry'));
    h.live().emit(resultMessage('steer-1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'answering after the retry'
      )
    ).toBe(true);
  });

  it('survives an auto compaction taken ahead of the continuation', async () => {
    // The other shape that precedes a continuation's first word, and one the
    // pump already drives end to end elsewhere: the CLI compacts to make room
    // for the steer's turn, then runs it.
    const h = harness({ graceMs: 40 });
    await steeredAndAnswered(h, [compactBoundaryMessage()]);

    await new Promise((resolve) => setTimeout(resolve, 150));
    h.live().emit(textDeltaMessage('answering after the compaction'));
    h.live().emit(resultMessage('steer-1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'answering after the compaction'
      )
    ).toBe(true);
  });

  it('closes at the cap when the process chatters and never speaks', async () => {
    // A process that emits bookkeeping forever must not hold a finished turn
    // open forever. The frames keep re-arming a 40ms grace, and the 200ms cap
    // is what ends it — on the CLI's own `result`, never on a synthetic error,
    // because the terminal is held throughout.
    const h = harness({ graceMs: 40, capMs: 200 });
    await steeredAndAnswered(h);

    const chatter = setInterval(() => h.live().emit(apiRetryMessage(20)), 20);
    try {
      await settled(h, 1);
    } finally {
      clearInterval(chatter);
    }

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.at(-1)).toBe('turn_end');
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
  });

  it('does not cut short a continuation that outruns the cap', async () => {
    // Content stops the clock DEAD rather than extending it, and this is why:
    // a continuation that works for longer than the cap is a turn in progress,
    // not a process sitting on a finished one. A 150ms cap against 400ms of
    // work would cut it in half if the first word merely postponed the close.
    const h = harness({ graceMs: 40, capMs: 150 });
    await steeredAndAnswered(h, [textDeltaMessage('starting on the tests')]);

    await new Promise((resolve) => setTimeout(resolve, 400));
    h.live().emit(textDeltaMessage('and here is the rest of it'));
    h.live().emit(resultMessage('steer-1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'and here is the rest of it'
      )
    ).toBe(true);
  });

  it('restarts the wait when a person steers into the grace', async () => {
    // 400ms of grace, spent in two 200ms halves with a steer between them. The
    // second half ends 200ms past the ORIGINAL deadline, so only a restarted
    // clock still has this window open when the answer arrives.
    const h = harness({ graceMs: 400 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    await new Promise((resolve) => setTimeout(resolve, 200));
    // The agent has just gone quiet, which is exactly when a person types.
    expect(h.windows.steerOpenWindow('steer-2')).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 200));
    h.live().emit(textDeltaMessage('answering the second steer'));
    h.live().emit(resultMessage('steer-2'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some(
        (e) => e.type === 'text_delta' && e.text === 'answering the second steer'
      )
    ).toBe(true);
  });

  it('does not wait at all when the result names the steer itself', async () => {
    // An hour of grace: a window that starts waiting here never closes, so the
    // drain below hangs. Nothing is outstanding once the steer is named.
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
    h.live().emit(textDeltaMessage('both, answered together'));
    h.live().emit(resultMessage('steer-1'));

    await settled(h, 1);
    expect(h.windowsOnStream()).toHaveLength(1);
  });

  it('keeps waiting while a SECOND steer is still unanswered', async () => {
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    expect(h.windows.steerOpenWindow('steer-1')).toBe(true);
    expect(h.windows.steerOpenWindow('steer-2')).toBe(true);
    // One of the two steers is answered; the other is not, so the turn is not
    // over and the continuation for it may still arrive. An hour of grace means
    // only the CLI naming `steer-2` can close this.
    h.live().emit(resultMessage('steer-1'));
    h.live().emit(textDeltaMessage('now the second one'));
    h.live().emit(resultMessage('steer-2'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(
      windows[0]!.events.some((e) => e.type === 'text_delta' && e.text === 'now the second one')
    ).toBe(true);
  });

  it('hands a dispatch the real result, not an abandonment', async () => {
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    // The person gives up waiting and sends the next message. The window in
    // hand finished its turn — it was only waiting to see whether more was
    // coming — so it settles on the CLI's own `result`.
    await h.dispatch([{ content: 'next thing', messageId: 'm2' }]);
    h.live().emit(resultMessage('m2'));
    await settled(h, 2);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(2);
    // No synthetic error anywhere: this is what separates settling on the real
    // result from abandoning the window, and it is the whole assertion.
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
    // The predecessor kept its own answer rather than losing it to the successor.
    expect(
      windows[0]!.events.some((e) => e.type === 'text_delta' && e.text === 'the first answer')
    ).toBe(true);
  });

  it('settles on the real result when the composer ends the turn, and says so', async () => {
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    // `settle-open-turn.ts` logs a `true` as "ended a turn that never
    // finished". This turn finished, so the answer must be `false` — otherwise
    // a healthy turn is reported as a failed one every time somebody steers.
    expect(h.windows.abandonOpenWindow()).toBe(false);

    await settled(h, 1);
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(false);
    expect(h.windowsOnStream()).toHaveLength(1);
  });

  it('lets a crash mid-grace close the window once, as a crash', async () => {
    const h = harness({ graceMs: 3_600_000, capMs: 3_600_000 });
    await steeredAndAnswered(h);
    await graceIsOpen(h);

    h.live().failStream(new Error('the CLI died'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.filter((t) => t === 'turn_end')).toHaveLength(1);
    expect(h.rawStream().some((e) => e.type === 'error')).toBe(true);
  });
});
