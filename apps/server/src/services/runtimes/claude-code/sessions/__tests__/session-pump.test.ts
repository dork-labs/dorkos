import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import {
  IllegalPumpTransitionError,
  PumpRefusedError,
  SessionPump,
  type PumpCrash,
  type PumpLaunchInput,
  type PumpQuery,
  type PumpState,
  type SessionPumpOptions,
} from '../session-pump.js';
import { backgroundTasksMessage, FakeQuery, initMessage } from './fake-pump-query.js';

/** A plain assistant-ish message, for asserting the demux sees the whole stream. */
function otherMessage(): SDKMessage {
  return { type: 'system', subtype: 'status', status: null } as unknown as SDKMessage;
}

interface Harness {
  pump: SessionPump;
  /** Every query the launcher handed out, in launch order. */
  queries: FakeQuery[];
  /** The most recent one. */
  live(): FakeQuery;
  launches: PumpLaunchInput[];
  states: Array<{ from: PumpState; to: PumpState }>;
  messages: SDKMessage[];
  crashes: PumpCrash[];
  /** Reach the input stream the way the SDK would: consume the held prompt. */
  readPrompt(index?: number): Promise<string[]>;
  /** The same read, keeping the correlation id each message was stamped with. */
  readStamped(index?: number): Promise<Array<{ content: string; uuid?: string }>>;
}

/** Build a pump over {@link FakeQuery}, with every seam recorded. */
function harness(overrides: Partial<SessionPumpOptions> = {}): Harness {
  const queries: FakeQuery[] = [];
  const launches: PumpLaunchInput[] = [];
  const states: Array<{ from: PumpState; to: PumpState }> = [];
  const messages: SDKMessage[] = [];
  const crashes: PumpCrash[] = [];
  const pump = new SessionPump({
    sessionId: 'sess-1',
    launch: (input) => {
      launches.push(input);
      const query = new FakeQuery();
      queries.push(query);
      return query;
    },
    onMessage: (message) => messages.push(message),
    onStateChange: (change) => states.push(change),
    onCrash: (crash) => crashes.push(crash),
    drainGraceMs: 20,
    ...overrides,
  });
  return {
    pump,
    queries,
    launches,
    states,
    messages,
    crashes,
    live: () => queries[queries.length - 1]!,
    readPrompt: async (index = 0) => (await readStamped(launches, index)).map((m) => m.content),
    readStamped: (index = 0) => readStamped(launches, index),
  };
}

/** Drain a launch's held prompt, keeping both what was sent and the id it carried. */
async function readStamped(
  launches: PumpLaunchInput[],
  index: number
): Promise<Array<{ content: string; uuid?: string }>> {
  const seen: Array<{ content: string; uuid?: string }> = [];
  const iterator = launches[index]!.prompt[Symbol.asyncIterator]();
  for (;;) {
    const next = await Promise.race([
      iterator.next(),
      new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), 5)),
    ]);
    if (next === 'idle' || next.done === true) break;
    const message = next.value as { message: { content: string }; uuid?: string };
    seen.push({
      content: message.message.content,
      ...(message.uuid !== undefined ? { uuid: message.uuid } : {}),
    });
  }
  return seen;
}

/** Drive a pump to WARM the way a caller would. */
async function warmed(h: Harness, capabilities?: string[]): Promise<void> {
  const warming = h.pump.warm();
  await vi.waitFor(() => expect(h.queries.length).toBe(1));
  h.live().emit(initMessage(capabilities));
  await warming;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('SessionPump — the state machine (spec §4.2)', () => {
  // Purpose: the first row of the table. A cold pump boots one process and
  // reports itself warming until the CLI says it is ready.
  it('COLD -> WARMING -> WARM on system/init', async () => {
    const h = harness();
    expect(h.pump.state).toBe('cold');
    expect(h.pump.warmth).toBe('cold');

    const warming = h.pump.warm();
    await vi.waitFor(() => expect(h.launches.length).toBe(1));
    expect(h.pump.state).toBe('warming');
    expect(h.pump.warmth).toBe('warming');

    h.live().emit(initMessage());
    await warming;
    expect(h.pump.state).toBe('warm');
    expect(h.pump.warmth).toBe('warm');
    expect(h.states).toEqual([
      { from: 'cold', to: 'warming' },
      { from: 'warming', to: 'warm' },
    ]);
  });

  // Purpose: the WARMING -> CRASHED row. A process that dies before init has
  // failed the launch, and the caller has to hear about it.
  it('WARMING -> CRASHED when the process dies before init', async () => {
    const h = harness();
    const warming = h.pump.warm();
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    h.live().failStream(new Error('spawn ENOENT'));

    await expect(warming).rejects.toThrow('spawn ENOENT');
    expect(h.pump.state).toBe('crashed');
    expect(h.pump.warmth).toBe('crashed');
    expect(h.crashes).toEqual([
      { sessionId: 'sess-1', stateAtCrash: 'warming', error: expect.any(Error) },
    ]);
  });

  // Purpose: an empty batch would move the machine to RUNNING with nothing
  // sent — a turn no result could ever close.
  it('refuses an empty batch rather than opening an unanswerable turn', async () => {
    const h = harness();
    await warmed(h);

    await expect(h.pump.dispatch([])).rejects.toMatchObject({ reason: 'empty-dispatch' });
    expect(h.pump.state).toBe('warm');
  });

  // Purpose: the RUNNING -> WARM row. The process survives the turn — that is
  // the entire point of the pump.
  it('RUNNING -> WARM on endTurn, with the process still up', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch([{ content: 'hello', messageId: 'msg-hello' }]);
    h.pump.endTurn();

    expect(h.pump.state).toBe('warm');
    expect(h.live().closed).toBe(0);
  });

  // Purpose: the RUNNING -> CRASHED row. The crash is reported with the turn
  // state, which is what task 3.6 needs to close the open window with an error.
  it('RUNNING -> CRASHED when the process dies mid-turn', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch([{ content: 'hello', messageId: 'msg-hello' }]);
    h.live().failStream(new Error('killed'));

    await vi.waitFor(() => expect(h.pump.state).toBe('crashed'));
    expect(h.crashes[0]?.stateAtCrash).toBe('running');
  });

  // Purpose: the WARM -> REAPED row and its polite close. Reaping is invisible:
  // warmth reads `cold` afterwards, which is what the person's next message
  // will find.
  it('WARM -> REAPED closes the stream and reports cold', async () => {
    const h = harness();
    await warmed(h);
    const query = h.live();

    await expect(h.pump.reap()).resolves.toBe(true);
    expect(h.pump.state).toBe('reaped');
    expect(h.pump.warmth).toBe('cold');
    expect(query.closed).toBe(1);
    expect(h.crashes).toEqual([]);
  });

  // Purpose: the CRASHED -> RESUMING -> WARMING -> WARM rows. Recovery is a
  // relaunch of the same pump, and the launcher is told it is a resume so it
  // can take the resume path.
  it('CRASHED -> RESUMING -> WARMING -> WARM on the next dispatch', async () => {
    const h = harness();
    await warmed(h);
    h.live().failStream(new Error('killed'));
    await vi.waitFor(() => expect(h.pump.state).toBe('crashed'));

    const dispatched = h.pump.dispatch([{ content: 'again', messageId: 'msg-again' }]);
    await vi.waitFor(() => expect(h.queries.length).toBe(2));
    h.live().emit(initMessage());
    await dispatched;

    expect(h.pump.state).toBe('running');
    expect(h.launches.map((l) => l.resuming)).toEqual([false, true]);
    expect(h.states.slice(-4)).toEqual([
      { from: 'crashed', to: 'resuming' },
      { from: 'resuming', to: 'warming' },
      { from: 'warming', to: 'warm' },
      { from: 'warm', to: 'running' },
    ]);
    expect(await h.readPrompt(1)).toEqual(['again']);
  });

  // Purpose: the "any -> COLD" row. Eviction is unconditional and closes the
  // process whatever it was doing.
  it('any -> COLD on teardown, even mid-turn', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch([{ content: 'hello', messageId: 'msg-hello' }]);
    const query = h.live();

    await h.pump.teardown('stop');
    expect(h.pump.state).toBe('cold');
    expect(h.pump.warmth).toBe('cold');
    expect(query.closed).toBe(1);
    // Teardown is not a crash: nobody should be told the session failed.
    expect(h.crashes).toEqual([]);
  });

  // Purpose: DOR-1187. On the cold path the pump reaches WARM (system/init)
  // before `dispatch` flips it to RUNNING, and a fast turn's `result` can close
  // the window in that gap. `endTurn()` is a no-op against a not-yet-RUNNING
  // pump, so before the fix the pump moved to RUNNING with no window left to
  // close it and STRANDED there — the next dispatch then threw an illegal
  // transition. The `fetchUsage` IPC round trip usually orders that close
  // safely, but a safety that rides on microtask timing is not one.
  //
  // Reproduced deterministically by closing the turn the instant the pump
  // reports WARM during the launch — the same moment a raced `result` would.
  it('does not strand in RUNNING when a result closes the turn before dispatch opens it', async () => {
    const queries: FakeQuery[] = [];
    // A holder breaks the cycle: `onStateChange` needs the pump, which needs
    // `onStateChange` to be constructed.
    const ref: { pump?: SessionPump } = {};
    let closedOnce = false;
    const pump = new SessionPump({
      sessionId: 'sess-1',
      launch: () => {
        const query = new FakeQuery();
        queries.push(query);
        return query;
      },
      onStateChange: (change) => {
        // The window's `result` lands and closes the turn exactly as the pump
        // reaches WARM, before `dispatch` has opened it — a no-op close today.
        if (change.to === 'warm' && !closedOnce) {
          closedOnce = true;
          ref.pump?.endTurn();
        }
      },
      drainGraceMs: 20,
    });
    ref.pump = pump;

    const dispatched = pump.dispatch([{ content: 'fast turn', messageId: 'msg-fast' }]);
    await vi.waitFor(() => expect(queries.length).toBe(1));
    queries[0]!.emit(initMessage());
    await dispatched;

    // The turn ran and closed, so the pump is WARM and ready — not stranded in
    // RUNNING with a window nothing can close.
    expect(pump.state).toBe('warm');

    // And the proof it is not stranded: the next turn opens instead of throwing
    // `IllegalPumpTransitionError('running','running')`.
    await pump.dispatch([{ content: 'the next turn', messageId: 'msg-next' }]);
    expect(pump.state).toBe('running');
  });
});

describe('SessionPump — guards', () => {
  // Purpose: firing a queued prompt into an open permission ask is answered by
  // nobody and read by the model as the person's reply. The guard is the whole
  // reason the probe is injected.
  it('refuses a dispatch while the session is parked on a person', async () => {
    let parked = false;
    const h = harness({ hasPendingInteraction: () => parked });
    await warmed(h);
    parked = true;

    await expect(
      h.pump.dispatch([{ content: 'hello', messageId: 'msg-hello' }])
    ).rejects.toMatchObject({
      name: 'PumpRefusedError',
      reason: 'pending-interaction',
    });
    expect(h.pump.state).toBe('warm');
    expect(await h.readPrompt()).toEqual([]);
  });

  // Purpose: a reaped process cannot answer the approval the person comes back
  // to, and the interaction timeout outlasts the idle window, so this race is
  // real.
  it('refuses a reap while the session is parked on a person', async () => {
    const h = harness({ hasPendingInteraction: () => true });
    await warmed(h);

    await expect(h.pump.reap()).resolves.toBe(false);
    expect(h.pump.state).toBe('warm');
    expect(h.live().closed).toBe(0);
  });

  // Purpose: a background subagent OUTLIVES the turn that launched it, so a
  // pump can be warm with an agent still working. Closing stdin then EOFs the
  // CLI's control stream, and the CLI answers that by cancelling every
  // hook-matched tool the agent runs afterwards — its work is thrown away and
  // it is told the person refused (DOR-1238).
  it('refuses a reap while a background subagent is still running', async () => {
    const h = harness();
    await warmed(h);

    h.live().emit(backgroundTasksMessage([{ id: 'agent-1', type: 'local_agent' }]));
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));

    await expect(h.pump.reap()).resolves.toBe(false);
    expect(h.pump.state).toBe('warm');
    expect(h.live().closed).toBe(0);

    // The level signal is what ends the hold: the agent leaves the set, and the
    // next ask goes through.
    h.live().emit(backgroundTasksMessage([]));
    await vi.waitFor(() => expect(h.messages).toHaveLength(3));

    await expect(h.pump.reap()).resolves.toBe(true);
    expect(h.live().closed).toBe(1);
  });

  // Purpose: a background SHELL is work its agent is waiting on (DOR-2065).
  // The CLI wakes the model when it finishes, and reaping kills it first.
  it('declines to reap a session whose only background task is a shell', async () => {
    const h = harness();
    await warmed(h);

    h.live().emit(backgroundTasksMessage([{ id: 'shell-1', type: 'local_bash' }]));
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));

    await expect(h.pump.reap()).resolves.toBe(false);
    expect(h.live().closed).toBe(0);
  });

  // Purpose: the level signal is per-PROCESS and is not replayed at startup, so
  // a set left over from a process that crashed mid-agent would keep the next
  // one from ever being reaped.
  it('forgets the background tasks of a process that has gone', async () => {
    const h = harness();
    await warmed(h);
    h.live().emit(backgroundTasksMessage([{ id: 'agent-1', type: 'local_agent' }]));
    await vi.waitFor(() => expect(h.messages).toHaveLength(2));
    h.live().failStream(new Error('killed'));
    await vi.waitFor(() => expect(h.pump.state).toBe('crashed'));

    const rewarming = h.pump.warm();
    await vi.waitFor(() => expect(h.queries).toHaveLength(2));
    h.live().emit(initMessage());
    await rewarming;

    await expect(h.pump.reap()).resolves.toBe(true);
  });

  // Purpose: only a WARM pump may be reaped. Reaping mid-turn would kill a turn
  // somebody is watching.
  it('refuses a reap while a turn is open', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch([{ content: 'hello', messageId: 'msg-hello' }]);

    await expect(h.pump.reap()).resolves.toBe(false);
    expect(h.pump.state).toBe('running');
    expect(h.live().closed).toBe(0);
  });

  // Purpose: the ceiling guard. With nothing able to reclaim a slot (task 3.4
  // installs the LRU that can), a launch over the ceiling is refused rather
  // than quietly booting a thirteenth subprocess.
  it('refuses to warm when the ceiling reserves no slot', async () => {
    const h = harness({
      reserveSlot: () =>
        Promise.reject(new PumpRefusedError('warm-ceiling', 'no slot could be reclaimed')),
    });

    await expect(h.pump.warm()).rejects.toMatchObject({ reason: 'warm-ceiling' });
    expect(h.pump.state).toBe('cold');
    expect(h.queries).toEqual([]);
  });

  // Purpose: a second dispatch on an open turn is a caller bug (the dispatch
  // mutex is the caller's), and must be loud rather than interleaved.
  it('refuses a second dispatch while a turn is open', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch([{ content: 'one', messageId: 'msg-one' }]);

    await expect(
      h.pump.dispatch([{ content: 'two', messageId: 'msg-two' }])
    ).rejects.toBeInstanceOf(IllegalPumpTransitionError);
    expect(await h.readPrompt()).toEqual(['one']);
  });

  // Purpose: `push()` returning false is the seam's one definite answer, and it
  // must not be reported as a dispatch that happened — the caller has to leave
  // the message queued.
  it('reports the process gone when the input stream refuses the message', async () => {
    const h = harness();
    await warmed(h);
    // The consumer walked away: the held prompt is finished, and `push` will
    // say so.
    await h.launches[0]!.prompt.return(undefined);

    await expect(
      h.pump.dispatch([{ content: 'hello', messageId: 'msg-hello' }])
    ).rejects.toMatchObject({
      reason: 'process-gone',
    });
    expect(h.pump.state).toBe('crashed');
  });

  // Purpose: a spent pump is not reusable. The registry drops it; anything
  // still holding one must fail loudly rather than boot a second process
  // outside the ceiling's count.
  it('refuses everything after a reap or a teardown', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.reap();

    await expect(h.pump.warm()).rejects.toBeInstanceOf(IllegalPumpTransitionError);
    await expect(h.pump.dispatch([{ content: 'x', messageId: 'msg-x' }])).rejects.toBeInstanceOf(
      IllegalPumpTransitionError
    );

    const torn = harness();
    await warmed(torn);
    await torn.pump.teardown('stop');
    await expect(torn.pump.warm()).rejects.toMatchObject({ reason: 'process-gone' });
  });
});

describe('SessionPump — launch and teardown', () => {
  // Purpose: shutdown racing a launch is the way a subprocess outlives DorkOS.
  // The launch has to notice the teardown when it returns and close what it got.
  it('a teardown during a launch closes the process the launcher returns', async () => {
    let release!: (query: PumpQuery) => void;
    let entered = false;
    const booting = new Promise<PumpQuery>((resolve) => {
      release = resolve;
    });
    const late = new FakeQuery();
    const h = harness({
      launch: () => {
        entered = true;
        return booting;
      },
    });

    const warming = h.pump.warm();
    await vi.waitFor(() => expect(entered).toBe(true));
    await h.pump.teardown('stop');
    release(late);

    await expect(warming).rejects.toMatchObject({ reason: 'process-gone' });
    expect(late.closed).toBe(1);
    expect(h.pump.state).toBe('cold');
  });

  // Purpose: a launcher that throws (a missing binary, bad auth) must leave the
  // pump recoverable rather than wedged, and must not leak the held stream.
  it('a launcher that throws crashes the pump and rejects the caller', async () => {
    const h = harness({
      launch: () => {
        throw new Error('claude binary not found');
      },
    });

    await expect(h.pump.warm()).rejects.toThrow('claude binary not found');
    expect(h.pump.state).toBe('crashed');
    expect(h.crashes[0]?.stateAtCrash).toBe('warming');
  });

  // Purpose: the polite close has to happen before the forceful one, or
  // messages the person was told had been accepted are dropped on the floor.
  it('reap closes stdin first, then the query', async () => {
    const h = harness();
    await warmed(h);
    const query = h.live();
    await h.pump.reap();

    // The held prompt is finished: the SDK would see stdin EOF and drain.
    await expect(h.launches[0]!.prompt.next()).resolves.toMatchObject({ done: true });
    // And the child is closed too, because stdin alone does not terminate it.
    expect(query.closed).toBe(1);
  });

  // Purpose: teardown must not hang on a process that will not drain. The
  // grace window is what turns a wedged child into a closed one.
  it('teardown gives up on a drain that will not finish and closes anyway', async () => {
    const h = harness({ drainGraceMs: 10 });
    await warmed(h);
    const query = h.live();
    // A query whose stream ignores the close is the wedged child.
    vi.spyOn(query, 'close').mockImplementation(() => {
      query.closed += 1;
    });

    await h.pump.teardown('stop');
    expect(query.closed).toBe(1);
    expect(h.pump.state).toBe('cold');
  });
});

describe('SessionPump — steer (P4 deliverIntoTurn, task 4.1)', () => {
  // Purpose: a steer joins the running turn by pushing into the SAME held stream
  // the opening message rode, behind it and in order, without moving the state
  // machine — the pump stays RUNNING.
  it('pushes into the open turn’s stream, behind the opening message, staying RUNNING', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch([{ content: 'do the thing', messageId: 'm-open' }]);

    expect(h.pump.steer('also check the tests', 'm-steer')).toBe('delivered');
    // Still RUNNING: a steer is not a second dispatch and opens no new turn.
    expect(h.pump.state).toBe('running');

    // Both messages reached the CLI's input stream, in order, each keeping its
    // own correlation id — which is what lets the coalesced result be matched.
    expect(await h.readStamped()).toEqual([
      { content: 'do the thing', uuid: 'm-open' },
      { content: 'also check the tests', uuid: 'm-steer' },
    ]);
  });
});

// Purpose: a bug in the consumer must not take down a subprocess holding
// somebody's conversation.
it('a demux that throws does not kill the process', async () => {
  const h = harness({
    onMessage: () => {
      throw new Error('demux bug');
    },
  });
  await warmed(h);
  h.live().emit(otherMessage());

  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(h.pump.state).toBe('warm');
  expect(h.crashes).toEqual([]);
});
