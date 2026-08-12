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
import { IllegalPumpTransitionError, SessionPump } from '../session-pump.js';
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
function harness(hooks: { onWindowClose?: (window: TurnWindow) => void } = {}): Harness {
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

  // The mutex the pump's contract says is honor-system. This is where it is
  // actually enforced for pump-driven turns.
  it('refuses a second dispatch while a window is open', async () => {
    const h = harness();

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    await expect(
      h.windows.dispatch([{ content: 'second', messageId: 'm2' }], CWD)
    ).rejects.toBeInstanceOf(IllegalPumpTransitionError);

    h.live().emit(resultMessage('m1'));
    await settled(h, 1);
    expect(h.windowsOnStream()).toHaveLength(1);
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
