/**
 * Shared setup for the session-turn-windows tests, split from one file by subject.
 *
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
import { expect, vi, afterEach, beforeAll } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { StreamEvent } from '@dorkos/shared/types';
import { initBoundary } from '../../../../../../lib/boundary.js';
import { feedProjector } from '../../../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../../../session/session-state-projector.js';
import { mapSdkMessage } from '../../../sdk/sdk-event-mapper.js';
import { createToolState } from '../../../agent-types.js';
import type { AgentSession } from '../../../agent-types.js';
import { SessionPump } from '../../session-pump.js';
import {
  SessionTurnWindows,
  type TurnWindow,
  type WindowedPump,
  type WindowUsage,
} from '../../session-turn-windows.js';
import { FakeQuery, initMessage } from '../fake-pump-query.js';

export const SESSION_ID = 'sess-1';

/**
 * The directory every dispatch in this file runs in — real, and inside the
 * boundary initialized below, because `dispatch` validates it before it sends
 * anything (task 3.9). What happens when it is NOT allowed is a subject of its
 * own, in `session-turn-windows-boundary.test.ts`.
 */
export const CWD = process.cwd();

beforeAll(async () => {
  await initBoundary(CWD);
});

afterEach(() => {
  vi.useRealTimers();
});

/**
 * Put the windower's grace and cap timers on a fake clock, so a case moves
 * time with `vi.advanceTimersByTimeAsync` instead of sleeping. Only timers and
 * `Date` are faked: the pump's async iteration still runs on real microtasks,
 * and `vi.waitFor` advances the fake clock by its interval on every check.
 * Real timers come back after each test.
 */
export function useFakeClock(): void {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
}

/**
 * A `result` that answers `answers`, or one that answers nothing it can name.
 *
 * @param answers - The id it names, through the singular field alone
 * @param extra - Extra result fields (`queued_turn_count`, `user_message_uuids`, …)
 */
export function resultMessage(answers?: string, extra: Record<string, unknown> = {}): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    uuid: `result-${answers ?? 'anonymous'}`,
    session_id: 'sdk-1',
    ...(answers !== undefined ? { user_message_uuid: answers } : {}),
    ...extra,
  } as unknown as SDKMessage;
}

/**
 * A `result` that names its WHOLE batch, as claude-agent-sdk 0.3.259 and later
 * do: `user_message_uuids` in consumption order, with the singular field
 * carrying the last member beside it exactly as the SDK documents ("always
 * contains user_message_uuid").
 *
 * Carrying both is what makes the tests below mutation-proof: code that reads
 * only the singular field still sees a plausible result and still closes the
 * window, so a case that goes red on the singular reader is red for a reason
 * about the LIST, never about a fixture the old code could not parse.
 *
 * @param answers - Every id this turn consumed, in order
 * @param extra - Extra result fields (`resume_reason`, `local_command`, …)
 */
export function coalescedResultMessage(
  answers: readonly string[],
  extra: Record<string, unknown> = {}
): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    total_cost_usd: 0.01,
    uuid: `result-${answers.join('+')}`,
    session_id: 'sdk-1',
    user_message_uuids: [...answers],
    user_message_uuid: answers.at(-1),
    ...extra,
  } as unknown as SDKMessage;
}

/**
 * The SDK's live thinking estimate (`system/thinking_tokens`), stamped since
 * 0.3.260 with the id of the message whose turn is thinking.
 *
 * The only thing a turn emits while thinking is redacted — the API streams
 * pings and the SDK digests them into this — so it is the earliest possible
 * proof that a turn has started.
 *
 * @param answers - The message this thinking belongs to, if the SDK named one
 */
export function thinkingTokensMessage(answers?: string): SDKMessage {
  return {
    type: 'system',
    subtype: 'thinking_tokens',
    estimated_tokens: 128,
    estimated_tokens_delta: 32,
    session_id: 'sdk-1',
    uuid: `thinking-${answers ?? 'anonymous'}`,
    ...(answers !== undefined ? { user_message_uuid: answers } : {}),
  } as unknown as SDKMessage;
}

/**
 * A `result` that names no message at all.
 *
 * This used to be the shape of every `SDKResultError`: until claude-agent-sdk
 * 0.3.268 the error result declared no `user_message_uuid`, so a failed turn
 * could arrive no other way. At 0.3.268 it declares one, so this is now the
 * shape of any result that simply carried no id — the case row 2 of the module's
 * table still has to answer, and the one this fixture is for.
 */
export function errorResultMessage(): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['the model gave up'],
    uuid: 'result-error',
    session_id: 'sdk-1',
  } as unknown as SDKMessage;
}

/**
 * The `result` the CLI sends once it has acked an interrupt and wound down:
 * an error subtype, and a terminal reason naming the abort.
 */
export function abortedResultMessage(answers: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'aborted_streaming',
    errors: ['[ede_diagnostic] result_type=user last_content_type=n/a stop_reason=null'],
    uuid: `result-stopped-${answers}`,
    session_id: 'sdk-1',
    user_message_uuid: answers,
  } as unknown as SDKMessage;
}

/** The model saying something — the content a window is supposed to carry. */
export function textDeltaMessage(text: string): SDKMessage {
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
export function apiRetryMessage(retryDelayMs: number): SDKMessage {
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
export function compactBoundaryMessage(): SDKMessage {
  return {
    type: 'system',
    subtype: 'compact_boundary',
    compact_metadata: { trigger: 'auto', pre_tokens: 38234, post_tokens: 3035, duration_ms: 19707 },
    session_id: 'sdk-1',
    uuid: 'boundary-auto',
  } as unknown as SDKMessage;
}

/** One window's slice of the durable stream, `turn_start` through `turn_end`. */
export interface ProjectedWindow {
  /** `turn_start.origin` — absent for the ordinary case, `'runtime'` for a window nobody asked for. */
  origin: string | undefined;
  types: string[];
  events: SessionEvent[];
}

export interface Harness {
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
export function harness(
  hooks: {
    onWindowClose?: (window: TurnWindow) => void;
    graceMs?: number;
    capMs?: number;
    emptyCloseCapMs?: number;
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
    ...(hooks.emptyCloseCapMs !== undefined ? { emptyCloseCapMs: hooks.emptyCloseCapMs } : {}),
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
export function settledOrPending(work: Promise<unknown>): Promise<'settled' | 'pending'> {
  return Promise.race([
    work.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 0)),
  ]);
}

/**
 * Report whether `work` settles within a short, bounded wait.
 *
 * For a dispatch that must not wait on a card or a helper: it may still take a
 * few real steps (timers, I/O) on a loaded machine, so one macrotask is too
 * tight a bound. A dispatch stuck behind a card waits minutes to hours, so a
 * two-second bound still tells the two apart.
 *
 * @param work - The promise being probed.
 * @param withinMs - How long to wait before answering `'pending'`.
 */
export function settlesWithin(
  work: Promise<unknown>,
  withinMs = 2_000
): Promise<'settled' | 'pending'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work.then(
      () => 'settled' as const,
      () => 'settled' as const
    ),
    new Promise<'pending'>((resolve) => {
      timer = setTimeout(() => resolve('pending'), withinMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** Cut the durable stream into windows at its `turn_start`/`turn_end` pairs. */
export function groupWindows(events: SessionEvent[]): ProjectedWindow[] {
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
 * against a stream that has not happened. Under {@link useFakeClock} it moves
 * the fake clock too, since nothing else will.
 */
export async function settled(h: Harness, windows: number): Promise<void> {
  await vi.waitFor(() => expect(h.opened.length).toBe(windows));
  const all = Promise.all(h.projected);
  if (!vi.isFakeTimers()) return void (await all);
  // On the fake clock nothing moves unless a test moves it: a close still
  // waits on the fake process's next-macrotask control answers and on its own
  // timers, so walk the clock forward until every window has ended.
  let done = false;
  void all.then(
    () => (done = true),
    () => (done = true)
  );
  while (!done) await vi.advanceTimersByTimeAsync(10);
  await all;
}

/**
 * The pump slice the windower drives, with no process behind it — enough for
 * the cases that never dispatch and only push frames in by hand.
 */
export function bareWindowedPump(): WindowedPump & { turnsEnded: number } {
  return {
    turnsEnded: 0,
    dispatch: vi.fn(async () => {}),
    endTurn(): void {
      this.turnsEnded += 1;
    },
    controlQuery: undefined,
  };
}
