/**
 * session-turn-windows: dispatch. Shared setup lives in `./session-turn-windows.fixtures.ts`.
 */
import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../../../../lib/logger.js';
import { PumpRefusedError } from '../../session-pump-contract.js';
import { SessionTurnWindows, type TurnWindow } from '../../session-turn-windows.js';
import { initMessage } from '../fake-pump-query.js';
import {
  SESSION_ID,
  CWD,
  resultMessage,
  coalescedResultMessage,
  abortedResultMessage,
  textDeltaMessage,
  apiRetryMessage,
  harness,
  settled,
} from './session-turn-windows.fixtures.js';

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

  // What reading the list is FOR, and the one case the singular field cannot
  // answer. A coalesced result names only its LAST member in `user_message_uuid`,
  // so `m1` used to stay on the sent-but-unanswered ledger after the process had
  // demonstrably spoken for it — and a later result naming `m1` would then close
  // a window that had nothing to do with it, through the DOR-1294 branch.
  //
  // Revert `readAnsweredIds` to the singular field and the last assertion goes
  // red: m3's window closes on a result for a message answered two turns ago.
  it('retires every id the list names, so a spent one cannot close a later window', async () => {
    const h = harness();

    await h.dispatch([
      { content: 'first', messageId: 'm1' },
      { content: 'second', messageId: 'm2' },
    ]);
    h.live().emit(coalescedResultMessage(['m1', 'm2']));
    await settled(h, 1);

    await h.windows.dispatch([{ content: 'third', messageId: 'm3' }], CWD);
    expect(h.windows.openWindow?.ids).toEqual(['m3']);

    // The CLI says something about `m1` again. It has already been spoken for,
    // so it is evidence about nothing — least of all about m3's turn.
    h.live().emit(resultMessage('m1'));
    await vi.waitFor(() => expect(h.opened.length).toBe(3));

    expect(h.windows.openWindow?.ids).toEqual(['m3']);
    expect(h.pump.state).toBe('running');
  });

  // `resume_reason` is set ONLY on the automatic re-run of a turn a host restart
  // interrupted, so a runtime window carrying one is explained rather than
  // surprising. Saying that at `warn` alongside genuine "the CLI answered
  // something nobody sent" trains people to ignore both.
  it('says why a turn nobody asked for happened, when the SDK explains it', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    try {
      const h = harness();

      await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
      h.live().emit(
        coalescedResultMessage(['m-rerun'], {
          resume_reason: 'host_draining',
          result_index: 4,
        })
      );
      await vi.waitFor(() => expect(h.opened.length).toBe(2));
      await h.projected[1];

      // The dispatched window is untouched — an explained turn is still not this
      // window's turn.
      expect(h.windows.openWindow?.ids).toEqual(['m1']);
      expect(h.windowsOnStream().at(-1)?.origin).toBe('runtime');

      const explained = info.mock.calls.find((call) =>
        String(call[0]).includes('a turn DorkOS did not ask for')
      );
      expect(explained?.[1]).toMatchObject({ resumeReason: 'host_draining', resultIndex: 4 });
      expect(
        warn.mock.calls.some((call) => String(call[0]).includes('this session never sent'))
      ).toBe(false);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
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

    // The warm process emits BOOKKEEPING with no window open: held for the next
    // window, exactly as before. A MODEL frame here would instead open a runtime
    // turn of its own (spec `warm-process-lifecycle` D6), which is a different
    // case and has its own test.
    windows.onMessage(apiRetryMessage(700));

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
    expect(got[0]).toMatchObject({ type: 'system', subtype: 'api_retry' });
    expect(got[1]).toMatchObject({ type: 'result' });
  });

  // Nothing the process says is lost — and since spec `warm-process-lifecycle`
  // D6, unprompted model speech is no longer folded into the NEXT person's turn.
  // It becomes a turn of its own, ahead of the message that follows it, so the
  // person reads the agent's words attributed to the agent rather than appearing
  // inside a turn they opened.
  it('gives unprompted speech its own turn ahead of the next dispatch', async () => {
    const h = harness();

    // Warm without dispatching: the init arrives with no window open.
    const warming = h.pump.warm();
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    h.live().emit(initMessage());
    await warming;
    expect(h.opened).toHaveLength(0);

    h.live().emit(textDeltaMessage('unprompted'));
    // Wait for the pump to have HANDED it over before dispatching, or the race
    // decides whether the window was open first and the test would pass whether
    // or not unprompted speech gets a turn.
    await vi.waitFor(() => expect(h.seen).toHaveLength(2));
    await vi.waitFor(() => expect(h.opened.length).toBe(1));
    h.live().emit(resultMessage());
    await settled(h, 1);

    // Only now can the person's turn start — the dispatch waits out the runtime
    // window rather than writing into the middle of it.
    await h.windows.dispatch([{ content: 'hello', messageId: 'm1' }], CWD);
    h.live().emit(textDeltaMessage('answering'));
    h.live().emit(resultMessage('m1'));
    await settled(h, 2);

    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(2);
    expect(windows[0]!.origin).toBe('runtime');
    expect(windows[0]!.events).toContainEqual(
      expect.objectContaining({ type: 'text_delta', text: 'unprompted' })
    );
    expect(windows[1]!.origin).toBeUndefined();
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
});

describe('SessionTurnWindows — a stopped turn ends without waiting on accounting (DOR-1319)', () => {
  it('closes a stopped window while the control channel is held, asking it nothing', async () => {
    // `holdControls` parks every control answer indefinitely, which is the
    // whole experiment: it stands in for the channel that took 4.5s to answer
    // after a Stop under load. An ordinary close parks here for its full
    // accounting budget; a stopped one must not spend any of it.
    const h = harness();
    await h.dispatch([{ content: 'do the thing', messageId: 'm1' }]);
    h.live().holdControls = true;

    h.live().emit(textDeltaMessage('starting on it'));
    h.live().emit(abortedResultMessage('m1'));

    await settled(h, 1);
    const windows = h.windowsOnStream();
    expect(windows).toHaveLength(1);
    expect(windows[0]!.types.at(-1)).toBe('turn_end');
    // Never asked, not merely not awaited. Nothing is parked, so nothing could
    // have been holding the person's composer.
    expect(h.live().parkedControls).toBe(0);
    expect(h.live().contextUsageCalls).toBe(0);
    expect(h.live().subscriptionUsageCalls).toBe(0);
    expect(h.usages).toEqual([]);
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
});
