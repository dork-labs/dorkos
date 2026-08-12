/**
 * What happens after a claude-code session's process dies (spec
 * `persistent-session-runtime` §4.2, task 3.6).
 *
 * Every case drives a real {@link SessionPump} over a scripted subprocess, a
 * real {@link SessionTurnWindows} cutting its output into windows, and a real
 * {@link SessionCrashRecovery} sitting on the crash seam — because the promise
 * under test spans all three: the window closes as a failure, the queue is
 * untouched, and the next dispatch resumes exactly once.
 *
 * The queue-preservation case uses the REAL {@link MessageQueueStore} over a
 * real SQLite database, not a stand-in. "The queue survives" is the entire
 * justification for the queue being server-owned, so it is proved against the
 * thing that actually stores it.
 *
 * @module services/runtimes/claude-code/sessions/__tests__/session-crash-recovery
 */
import { describe, it, expect, vi } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';
import { createTestDb } from '@dorkos/test-utils/db';
import { feedProjector } from '../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../session/session-state-projector.js';
import { MessageQueueStore } from '../../../../session/message-queue-store.js';
import { mapSdkMessage } from '../../sdk/sdk-event-mapper.js';
import { createToolState } from '../../agent-types.js';
import type { AgentSession } from '../../agent-types.js';
import { SessionPump } from '../session-pump.js';
import type { PumpLaunchInput } from '../session-pump-contract.js';
import { SessionTurnWindows, type TurnWindow } from '../session-turn-windows.js';
import {
  AUTOMATIC_RESUMES_PER_CRASH,
  SessionCrashLoopError,
  SessionCrashRecovery,
  type CrashRecord,
} from '../session-crash-recovery.js';
import { FakeQuery, initMessage } from './fake-pump-query.js';

const SESSION_ID = 'sess-1';
const CLIENT_ID = 'client-1';

/** A `result` that answers `answers` — the ordinary end of a turn. */
function resultMessage(answers: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    uuid: `result-${answers}`,
    session_id: 'sdk-1',
    user_message_uuid: answers,
  } as unknown as SDKMessage;
}

/** The model saying something. */
function textDeltaMessage(text: string): SDKMessage {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'text_delta', text } },
  } as unknown as SDKMessage;
}

/** How a harness's scripted subprocess behaves once it has reported init. */
interface HarnessHooks {
  /** Every launched process dies immediately after reporting itself ready. */
  dieAfterInit?: boolean;
  /** Retire a window's queue rows as it opens — see {@link Harness.store}. */
  store?: MessageQueueStore;
  /**
   * Runs when a window closes — including the SYNCHRONOUS close a crash causes.
   * This is the seam the composition root pumps the queue from.
   */
  onWindowClose?: () => void;
  /** Pin the clock the crash record is stamped from. */
  now?: () => number;
}

interface Harness {
  pump: SessionPump;
  windows: SessionTurnWindows;
  recovery: SessionCrashRecovery;
  /** Every launch the pump asked for, in order — `resuming` is the resume proof. */
  launches: PumpLaunchInput[];
  queries: FakeQuery[];
  /** The process booted most recently. */
  live: () => FakeQuery;
  /** Every window that opened, in order. */
  opened: TurnWindow[];
  /** Every crash the recovery recorded, in order. */
  crashes: CrashRecord[];
  /** The durable stream so far. */
  stream: () => SessionEvent[];
  /** Every StreamEvent each window produced, in window order. */
  streamEvents: StreamEvent[][];
  /** Dispatch through the recovery — the crash-aware ingress. */
  dispatch: (batch: Array<{ content: string; messageId: string }>) => Promise<TurnWindow>;
  /** Boot without running a turn, so a crash lands on a WARM session. */
  warm: () => Promise<void>;
  /** Wait until the pump has observed the death of its process. */
  awaitCrash: (count: number) => Promise<void>;
}

/**
 * A pump, a windower, a projector and the crash recovery, wired as the runtime
 * will wire them: the pump's `onCrash` reaches the RECOVERY (which forwards to
 * the windower), and every dispatch goes through the recovery rather than
 * straight at the windower.
 */
function harness(hooks: HarnessHooks = {}): Harness {
  const launches: PumpLaunchInput[] = [];
  const queries: FakeQuery[] = [];
  const opened: TurnWindow[] = [];
  const crashes: CrashRecord[] = [];
  const projected: Promise<void>[] = [];
  const streamEvents: StreamEvent[][] = [];
  const projector = new SessionStateProjector(SESSION_ID);
  const session = {} as AgentSession;
  const toolState = createToolState();

  const ref: { windows?: SessionTurnWindows; recovery?: SessionCrashRecovery } = {};
  const pump = new SessionPump({
    sessionId: SESSION_ID,
    launch: (input) => {
      launches.push(input);
      const query = new FakeQuery();
      queries.push(query);
      // The CLI reports itself ready on a later macrotask, as a real one does,
      // and dies on a later one still — so the crash lands cleanly after the
      // dispatch that booted it rather than racing its own launch.
      setTimeout(() => {
        query.emit(initMessage());
        if (hooks.dieAfterInit === true) {
          setTimeout(() => query.failStream(new Error('the CLI died')), 0);
        }
      }, 0);
      return query;
    },
    onMessage: (message) => ref.windows?.onMessage(message),
    onCrash: (crash) => ref.recovery?.handleCrash(crash),
    onStateChange: (change) => ref.recovery?.noteStateChange(change),
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
    usageTimeoutMs: 200,
    onWindowOpen: (window) => {
      opened.push(window);
      // The dispatcher retires a row at the `turn_start` the projector ingests,
      // which is the event THIS window's projection produces — so this is the
      // same instant, modelled at the seam this suite can reach.
      for (const id of window.ids) hooks.store?.remove(id);
      projected.push(project(window));
    },
    ...(hooks.onWindowClose === undefined ? {} : { onWindowClose: hooks.onWindowClose }),
  });

  const recovery = new SessionCrashRecovery({
    sessionId: SESSION_ID,
    pump,
    windows,
    onCrashRecorded: (record) => crashes.push(record),
    ...(hooks.now === undefined ? {} : { now: hooks.now }),
  });

  ref.windows = windows;
  ref.recovery = recovery;

  return {
    pump,
    windows,
    recovery,
    launches,
    queries,
    opened,
    crashes,
    streamEvents,
    live: () => queries[queries.length - 1]!,
    stream: () => projector.replayFrom(0),
    dispatch: (batch) => recovery.dispatch(batch),
    warm: () => pump.warm(),
    awaitCrash: async (count) => {
      await vi.waitFor(() => expect(crashes.length).toBeGreaterThanOrEqual(count));
    },
  };
}

/** Run one whole turn on a live process: dispatch, speak, answer. */
async function runTurn(h: Harness, messageId: string): Promise<void> {
  await h.dispatch([{ content: messageId, messageId }]);
  h.live().emit(textDeltaMessage(`answering ${messageId}`));
  h.live().emit(resultMessage(messageId));
  await vi.waitFor(() => expect(h.pump.state).toBe('warm'));
}

describe('SessionCrashRecovery', () => {
  // AC1. The process dies mid-turn. The recovery sits on the crash seam, so
  // wiring it there must not cost the window its terminal.
  it('closes the open window with exactly one turn_end{error} when the process dies mid-turn', async () => {
    const h = harness();

    await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
    h.live().emit(textDeltaMessage('working on it'));
    h.live().failStream(new Error('the CLI died'));
    await h.awaitCrash(1);
    await vi.waitFor(() => expect(h.stream().filter((e) => e.type === 'turn_end')).toHaveLength(1));

    const stream = h.stream();
    expect(stream.filter((e) => e.type === 'turn_start')).toHaveLength(1);
    expect(stream.find((e) => e.type === 'turn_end')).toMatchObject({ terminalReason: 'error' });
    expect(stream.some((e) => e.type === 'error')).toBe(true);
    expect(h.pump.warmth).toBe('crashed');
    expect(h.windows.openWindow).toBeUndefined();
  });

  // AC2 + AC3, end to end and against the real store: three messages queued,
  // the first turn crashes, and the two behind it are STILL THERE, in order,
  // with the ids they were accepted under — then they run on the resumed
  // process.
  it('preserves the queue across a crash and runs the survivors in order on the resumed process', async () => {
    const store = new MessageQueueStore(createTestDb());
    const h = harness({ store });
    const rows = ['first', 'second', 'third'].map((content) =>
      store.enqueue({ sessionId: SESSION_ID, content, clientId: CLIENT_ID })
    );
    const [m1, m2, m3] = rows.map((row) => row.id);

    await h.dispatch([{ content: 'first', messageId: m1! }]);
    h.live().failStream(new Error('the CLI died'));
    await h.awaitCrash(1);

    // The crash cleared nothing: the in-flight turn's row retired at its
    // `turn_start`, and the two behind it are untouched.
    expect(store.list(SESSION_ID).map((row) => row.id)).toEqual([m2, m3]);
    expect(store.list(SESSION_ID).map((row) => row.content)).toEqual(['second', 'third']);

    await runTurn(h, m2!);
    await runTurn(h, m3!);

    // Resumed, not restarted: the relaunch took the resume path.
    expect(h.launches.map((launch) => launch.resuming)).toEqual([false, true]);
    expect(h.queries).toHaveLength(2);
    // The survivors ran in order, under their ORIGINAL ids.
    expect(h.opened.map((window) => window.ids)).toEqual([[m1], [m2], [m3]]);
    expect(store.list(SESSION_ID)).toEqual([]);
  });

  // AC3. The recovered turn sees the prior conversation because the relaunch
  // takes the resume path — the fingerprint side of that is task 3.5's, but
  // which path was asked for is decided HERE and is provable here.
  it('resumes rather than starting fresh on the first dispatch after a crash', async () => {
    const h = harness();

    await h.dispatch([{ content: 'hello', messageId: 'm1' }]);
    h.live().failStream(new Error('the CLI died'));
    await h.awaitCrash(1);
    await runTurn(h, 'm2');

    expect(h.launches).toHaveLength(2);
    expect(h.launches[0]!.resuming).toBe(false);
    expect(h.launches[1]!.resuming).toBe(true);
  });

  // AC4. Nothing was running, so nothing may appear to have failed.
  it('reports a crash while WARM as crashed with no turn on the stream', async () => {
    const h = harness();

    await h.warm();
    await vi.waitFor(() => expect(h.pump.state).toBe('warm'));
    h.live().failStream(new Error('the CLI died while idle'));
    await h.awaitCrash(1);

    expect(h.pump.warmth).toBe('crashed');
    expect(h.crashes[0]).toMatchObject({ stateAtCrash: 'warm' });
    expect(h.opened).toEqual([]);
    expect(h.stream()).toEqual([]);
  });

  // The held-buffer decision, pinned. A dead process's unattributed output is
  // DROPPED with a notice, never carried into the next process's window: the
  // durable queue is the reconciliation for input, and held SDK messages are
  // OUTPUT.
  it('drops a dead process words rather than flushing them into the next process window', async () => {
    const h = harness();

    await h.warm();
    await vi.waitFor(() => expect(h.pump.state).toBe('warm'));
    h.live().emit(textDeltaMessage('a thought the dying process had'));
    await vi.waitFor(() => expect(h.pump.state).toBe('warm'));
    h.live().failStream(new Error('the CLI died while idle'));
    await h.awaitCrash(1);

    await runTurn(h, 'm1');

    const firstWindow = h.streamEvents[0] ?? [];
    const text = JSON.stringify(firstWindow);
    expect(text).not.toContain('a thought the dying process had');
    expect(text).toContain('answering m1');
    // And the `system/init` the explicit warm produced did not mint a turn of
    // its own on the way past either.
    expect(h.stream().filter((e) => e.type === 'turn_start')).toHaveLength(1);
  });

  // AC5, and the reason the bound exists: a genuinely broken session must not
  // spin up processes on its own.
  it('resumes once after a crash and refuses the dispatch after a second consecutive crash', async () => {
    const h = harness({ dieAfterInit: true });

    // The launch itself dies, so the first dispatch's own process crashes.
    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    await h.awaitCrash(1);
    expect(h.launches).toHaveLength(1);

    // One automatic resume — the crash's whole allowance.
    await h.dispatch([{ content: 'second', messageId: 'm2' }]);
    await h.awaitCrash(2);
    expect(h.launches).toHaveLength(2);

    // The second consecutive crash spends it. This dispatch is refused rather
    // than booting a third process.
    await expect(h.dispatch([{ content: 'third', messageId: 'm3' }])).rejects.toBeInstanceOf(
      SessionCrashLoopError
    );
    expect(h.launches).toHaveLength(2);
    // Spent back down to one crash, not to zero — the refusal is a message to a
    // person, and their next attempt gets exactly one more launch.
    expect(h.recovery.consecutiveCrashes).toBe(AUTOMATIC_RESUMES_PER_CRASH);
    expect(h.recovery.willAutoResume).toBe(true);
  });

  // Refusing is a message to a person, not a brick. Their next attempt tries
  // again — and if it fails the same way, it is refused again. One launch per
  // two dispatches, forever, with every failure visible.
  it('alternates refusal and attempt rather than bricking the session', async () => {
    const h = harness({ dieAfterInit: true });

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    await h.awaitCrash(1);
    await h.dispatch([{ content: 'second', messageId: 'm2' }]);
    await h.awaitCrash(2);
    await expect(h.dispatch([{ content: 'third', messageId: 'm3' }])).rejects.toBeInstanceOf(
      SessionCrashLoopError
    );

    // The person tries again: allowed, and it boots.
    await h.dispatch([{ content: 'fourth', messageId: 'm4' }]);
    await h.awaitCrash(3);
    expect(h.launches).toHaveLength(3);

    // And it failed the same way, so the one after it is refused again.
    await expect(h.dispatch([{ content: 'fifth', messageId: 'm5' }])).rejects.toBeInstanceOf(
      SessionCrashLoopError
    );
    expect(h.launches).toHaveLength(3);
  });

  // A turn that COMPLETED is the only evidence the session is healthy again.
  // Reaching `system/init` is not: the failure this bounds is a process that
  // boots fine and dies mid-turn.
  it('gives a session that recovered its full allowance back', async () => {
    const h = harness();

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    h.live().failStream(new Error('the CLI died'));
    await h.awaitCrash(1);

    await runTurn(h, 'm2');
    expect(h.recovery.consecutiveCrashes).toBe(0);

    // A second crash, now with a completed turn between: it resumes again.
    await h.dispatch([{ content: 'third', messageId: 'm3' }]);
    h.live().failStream(new Error('the CLI died again'));
    await h.awaitCrash(2);
    await runTurn(h, 'm4');

    expect(h.launches.map((launch) => launch.resuming)).toEqual([false, true, true]);
  });

  // The ORDER inside `handleCrash` is load-bearing, and this is the case that
  // proves it. Closing the crashed window calls `onWindowClose` SYNCHRONOUSLY
  // (`session-turn-windows.ts`), and that is the boundary a composition root
  // pumps the queue from — so a dispatch fired there runs INSIDE the crash
  // handler. Record-then-forward means it is already bound by the crash that
  // caused it; forward-then-record would let it boot a third process on the
  // count from the first crash.
  it('counts the crash before closing the window, so a dispatch on that boundary is already bound', async () => {
    const settled: Array<Promise<unknown>> = [];
    let armed = false;
    const ref: { dispatch?: Harness['dispatch'] } = {};
    const h = harness({
      dieAfterInit: true,
      onWindowClose: () => {
        if (!armed) return;
        armed = false;
        // Attach the handlers now, in the same beat, so the refusal is never a
        // stray unhandled rejection while the test waits.
        settled.push(
          ref.dispatch!([{ content: 'next', messageId: 'm-next' }]).then(
            () => 'launched',
            (err: unknown) => err
          )
        );
      },
    });
    ref.dispatch = h.dispatch;

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    await h.awaitCrash(1);
    // The next crash is the one that spends the allowance. Fire the boundary
    // dispatch from inside it.
    armed = true;
    await h.dispatch([{ content: 'second', messageId: 'm2' }]);
    await h.awaitCrash(2);

    await vi.waitFor(() => expect(settled).toHaveLength(1));
    expect(await settled[0]).toBeInstanceOf(SessionCrashLoopError);
    expect(h.launches).toHaveLength(2);
  });

  // Operator visibility: what died, where, when, and how many times in a row.
  it('records every crash with the state it happened in and the run of them', async () => {
    const h = harness({ dieAfterInit: true, now: () => 1_700_000_000_000 });

    await h.dispatch([{ content: 'first', messageId: 'm1' }]);
    await h.awaitCrash(1);
    await h.dispatch([{ content: 'second', messageId: 'm2' }]);
    await h.awaitCrash(2);

    expect(h.crashes).toHaveLength(2);
    expect(h.crashes[0]).toMatchObject({
      sessionId: SESSION_ID,
      stateAtCrash: 'running',
      consecutive: 1,
      willAutoResume: true,
      at: 1_700_000_000_000,
    });
    expect(h.crashes[0]!.message).toContain('the CLI died');
    expect(h.crashes[1]).toMatchObject({ consecutive: 2, willAutoResume: false });
    expect(h.recovery.lastCrash).toBe(h.crashes[1]);
  });
});
