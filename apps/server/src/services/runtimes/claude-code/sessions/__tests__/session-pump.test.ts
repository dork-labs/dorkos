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

/**
 * A scriptable stand-in for one SDK subprocess.
 *
 * It is an async iterable over messages a test pushes in, plus the `close()`
 * that terminates the child. `endStream`/`failStream` are how a test kills the
 * process; `close()` records that the pump reached for the forceful teardown.
 */
class FakeQuery implements PumpQuery {
  closed = 0;
  /** Messages waiting for the consumer, and the parked consumer's waker. */
  private readonly pending: SDKMessage[] = [];
  private wake: (() => void) | undefined;
  private done = false;
  private failure: unknown;

  emit(message: SDKMessage): void {
    this.pending.push(message);
    this.wake?.();
    this.wake = undefined;
  }

  /** The subprocess exited cleanly (stdin closed, or it just went away). */
  endStream(): void {
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  /** The subprocess died and the generator threw. */
  failStream(err: unknown): void {
    this.failure = err;
    this.done = true;
    this.wake?.();
    this.wake = undefined;
  }

  close(): void {
    this.closed += 1;
    this.endStream();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    for (;;) {
      while (this.pending.length > 0) yield this.pending.shift()!;
      if (this.failure !== undefined) throw this.failure;
      if (this.done) return;
      await new Promise<void>((resolve) => {
        this.wake = resolve;
      });
    }
  }
}

/** The `system/init` message, with whatever protocol capabilities a test wants. */
function initMessage(capabilities?: string[]): SDKMessage {
  return {
    type: 'system',
    subtype: 'init',
    apiKeySource: 'user',
    claude_code_version: '0.0.0-test',
    cwd: '/tmp',
    tools: [],
    mcp_servers: [],
    model: 'test-model',
    permissionMode: 'default',
    slash_commands: [],
    output_style: 'default',
    skills: [],
    plugins: [],
    ...(capabilities !== undefined ? { capabilities } : {}),
    uuid: '00000000-0000-0000-0000-000000000000',
    session_id: 'sess-1',
  } as SDKMessage;
}

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
    readPrompt: async (index = 0) => {
      const seen: string[] = [];
      const iterator = launches[index]!.prompt[Symbol.asyncIterator]();
      for (;;) {
        const next = await Promise.race([
          iterator.next(),
          new Promise<'idle'>((resolve) => setTimeout(() => resolve('idle'), 5)),
        ]);
        if (next === 'idle' || next.done === true) break;
        seen.push(next.value.message.content);
      }
      return seen;
    },
  };
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

  // Purpose: an explicit warm runs NO turn. `createIdlePrompt` is what makes
  // that true, and a prompt that yielded anything would spend tokens nobody
  // asked to spend.
  it('an explicit warm sends no user message', async () => {
    const h = harness();
    await warmed(h);
    expect(await h.readPrompt()).toEqual([]);
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

  // Purpose: the WARM -> RUNNING row, and the acceptance seam. The message
  // reaches the held stream, and the pump reports a turn open.
  it('WARM -> RUNNING on dispatch, pushing into the held stream', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch({ content: 'hello' });

    expect(h.pump.state).toBe('running');
    expect(h.pump.warmth).toBe('running');
    expect(await h.readPrompt()).toEqual(['hello']);
    expect(h.queries.length).toBe(1);
  });

  // Purpose: the RUNNING -> WARM row. The process survives the turn — that is
  // the entire point of the pump.
  it('RUNNING -> WARM on endTurn, with the process still up', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch({ content: 'hello' });
    h.pump.endTurn();

    expect(h.pump.state).toBe('warm');
    expect(h.live().closed).toBe(0);
  });

  // Purpose: a second `result` must be harmless, exactly as task 0.1's
  // idempotent closeTurn makes it on the projector.
  it('endTurn is idempotent and a no-op with no window open', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch({ content: 'hello' });
    h.pump.endTurn();
    h.pump.endTurn();

    expect(h.pump.state).toBe('warm');
    expect(h.states.filter((s) => s.to === 'warm').length).toBe(2);
  });

  // Purpose: the RUNNING -> CRASHED row. The crash is reported with the turn
  // state, which is what task 3.6 needs to close the open window with an error.
  it('RUNNING -> CRASHED when the process dies mid-turn', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch({ content: 'hello' });
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

    const dispatched = h.pump.dispatch({ content: 'again' });
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
    await h.pump.dispatch({ content: 'hello' });
    const query = h.live();

    await h.pump.teardown();
    expect(h.pump.state).toBe('cold');
    expect(h.pump.warmth).toBe('cold');
    expect(query.closed).toBe(1);
    // Teardown is not a crash: nobody should be told the session failed.
    expect(h.crashes).toEqual([]);
  });

  // Purpose: a dispatch on a cold pump is one launch carrying the message, not
  // a launch followed by a push — so there is no window where the process is up
  // and the message is merely "accepted".
  it('a cold dispatch rides the launch: COLD -> WARMING -> WARM -> RUNNING', async () => {
    const h = harness();
    const dispatched = h.pump.dispatch({ content: 'first words' });
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    h.live().emit(initMessage());
    await dispatched;

    expect(h.pump.state).toBe('running');
    expect(await h.readPrompt()).toEqual(['first words']);
    expect(h.states).toEqual([
      { from: 'cold', to: 'warming' },
      { from: 'warming', to: 'warm' },
      { from: 'warm', to: 'running' },
    ]);
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

    await expect(h.pump.dispatch({ content: 'hello' })).rejects.toMatchObject({
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

  // Purpose: only a WARM pump may be reaped. Reaping mid-turn would kill a turn
  // somebody is watching.
  it('refuses a reap while a turn is open', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.dispatch({ content: 'hello' });

    await expect(h.pump.reap()).resolves.toBe(false);
    expect(h.pump.state).toBe('running');
    expect(h.live().closed).toBe(0);
  });

  // Purpose: reap is idempotent and a no-op when there is no process, because
  // its callers are timers and sweeps that cannot know the answer in advance.
  it('reap is idempotent and a no-op when cold', async () => {
    const h = harness();
    await expect(h.pump.reap()).resolves.toBe(false);

    await warmed(h);
    await expect(h.pump.reap()).resolves.toBe(true);
    await expect(h.pump.reap()).resolves.toBe(false);
    expect(h.queries[0]!.closed).toBe(1);
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
    await h.pump.dispatch({ content: 'one' });

    await expect(h.pump.dispatch({ content: 'two' })).rejects.toBeInstanceOf(
      IllegalPumpTransitionError
    );
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

    await expect(h.pump.dispatch({ content: 'hello' })).rejects.toMatchObject({
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
    await expect(h.pump.dispatch({ content: 'x' })).rejects.toBeInstanceOf(
      IllegalPumpTransitionError
    );

    const torn = harness();
    await warmed(torn);
    await torn.pump.teardown();
    await expect(torn.pump.warm()).rejects.toMatchObject({ reason: 'process-gone' });
  });
});

describe('SessionPump — launch and teardown', () => {
  // Purpose: two callers racing to warm one session must not produce two CLI
  // subprocesses. This is the memo on the in-flight launch, and it is the bug
  // the ceiling could never catch.
  it('two concurrent launches share one process', async () => {
    const h = harness();
    const first = h.pump.warm();
    const second = h.pump.warm();
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    h.live().emit(initMessage());
    await Promise.all([first, second]);

    expect(h.queries.length).toBe(1);
    expect(h.launches.length).toBe(1);
  });

  // Purpose: a dispatch arriving while somebody else's warm is still booting
  // waits for it instead of launching beside it.
  it('a dispatch during a launch joins it rather than starting a second', async () => {
    const h = harness();
    const warming = h.pump.warm();
    await vi.waitFor(() => expect(h.queries.length).toBe(1));
    const dispatched = h.pump.dispatch({ content: 'hello' });
    h.live().emit(initMessage());
    await Promise.all([warming, dispatched]);

    expect(h.queries.length).toBe(1);
    expect(h.pump.state).toBe('running');
    expect(await h.readPrompt()).toEqual(['hello']);
  });

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
    await h.pump.teardown();
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

  // Purpose: nothing else bounds the pre-init window, so a process that boots
  // and never initializes would hold a dispatch open for as long as the server
  // runs.
  it('a launch that never initializes is called dead', async () => {
    const h = harness({ initTimeoutMs: 20 });

    await expect(h.pump.warm()).rejects.toThrow(/system\/init/);
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

    await h.pump.teardown();
    expect(query.closed).toBe(1);
    expect(h.pump.state).toBe('cold');
  });

  // Purpose: teardown is called from shutdown paths that may run twice.
  it('teardown is idempotent', async () => {
    const h = harness();
    await warmed(h);
    await h.pump.teardown();
    await h.pump.teardown();
    expect(h.queries[0]!.closed).toBe(1);
  });
});

describe('SessionPump — capabilities and the demux seam', () => {
  // Purpose: feature-detect, never version-sniff. What the CLI reports at init
  // is what the pump believes.
  it('caches the protocol capabilities system/init reports', async () => {
    const h = harness();
    await warmed(h, ['interrupt_receipt_v1']);

    expect(h.pump.capabilities).toEqual(['interrupt_receipt_v1']);
    expect(h.pump.supports('interrupt_receipt_v1')).toBe(true);
    expect(h.pump.supports('interrupt_cancel_queued_v1')).toBe(false);
  });

  // Purpose: an older CLI reports no capabilities at all, and must degrade
  // honestly rather than crash or be assumed capable.
  it('an older CLI that reports no capabilities supports nothing', async () => {
    const h = harness();
    await warmed(h);
    expect(h.pump.capabilities).toEqual([]);
    expect(h.pump.supports('interrupt_receipt_v1')).toBe(false);
  });

  // Purpose: a relaunch gets its own process, so it must not inherit the
  // previous one's answers.
  it('a relaunch after a crash starts from no capabilities', async () => {
    const h = harness();
    await warmed(h, ['interrupt_receipt_v1']);
    h.live().failStream(new Error('killed'));
    await vi.waitFor(() => expect(h.pump.state).toBe('crashed'));

    const dispatched = h.pump.dispatch({ content: 'again' });
    await vi.waitFor(() => expect(h.queries.length).toBe(2));
    expect(h.pump.capabilities).toEqual([]);
    h.live().emit(initMessage([]));
    await dispatched;
    expect(h.pump.capabilities).toEqual([]);
  });

  // Purpose: task 3.3 cuts turn windows out of this stream, so it must see
  // every message, in order, including the init.
  it('hands every message to the demux, in order', async () => {
    const h = harness();
    await warmed(h);
    h.live().emit(otherMessage());
    await vi.waitFor(() => expect(h.messages.length).toBe(2));

    expect(h.messages[0]).toMatchObject({ subtype: 'init' });
    expect(h.messages[1]).toMatchObject({ subtype: 'status' });
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
});
