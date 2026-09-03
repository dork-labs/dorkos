/**
 * How an API refusal that ABORTED the turn settles, driven through the real
 * seam rather than asserted at either end of it (DOR-1684).
 *
 * The unit tests on both sides of this chain are thorough — the result mapper's
 * own suite pins what it stamps on `session_status`, and the projector's pins
 * how `deriveTurnEndLifecycle` reads a hand-fed `turn_end`. Neither proves the
 * two halves MEET: the intent has to survive the mapper, the normalizer's
 * pair-latch, and the `turn_end` it closes the window with before settlement
 * ever sees it, and a break anywhere along that path leaves both unit suites
 * green while a refusal is once again reported as a turn the operator stopped.
 *
 * So this drives one SDK `result` through `mapSdkMessageWithMedia` — the
 * mapping entry point BOTH dispatch paths actually call — then `feedProjector`
 * and `SessionStateProjector`, with the stop record read by the real
 * {@link stopWasAimedAt} off a real `stoppedQueries`, and asks the projector —
 * live and after a cold hydrate — who it thinks ended the turn.
 *
 * ## The SDK shapes, verified against the shipped binary
 *
 * Checked against `@anthropic-ai/claude-agent-sdk` 0.3.224 (CLI 2.1.224) rather
 * than assumed; the extraction recipe and the full findings are in
 * `research/20260903_claude-cli-aborted-refusal-shapes.md`. What the fixtures
 * below encode:
 *
 * - The CLI's own abort predicate is `reason === 'aborted_streaming' ||
 *   reason === 'aborted_tools'`, and BOTH are returned from one
 *   `abortController.signal.aborted` check. Nine distinct causes reach it,
 *   `refusal-fallback-edit` among them, and the cause never reaches the SDK
 *   surface — so the shape genuinely cannot name the intent.
 * - A refusal-caused abort and DorkOS's own `query.interrupt()` are the two
 *   members of the same suppression set in the CLI (`['interrupt',
 *   'refusal-fallback-edit']`), which is why they arrive here identical.
 * - An abort whose last message was NOT assistant content closes as
 *   `subtype: 'error_during_execution'`, `is_error: true`, with the CLI's own
 *   `[ede_diagnostic] turn aborted (<reason>) stop_reason=<stop_reason>` line
 *   in `errors` — `stop_reason: 'refusal'` for a refusal. That is the fatal
 *   frame this turn must keep.
 * - An abort that DID produce assistant content closes `subtype: 'success'`
 *   instead, so no error frame exists and the turn settles `interrupted` on
 *   both paths. Pinned below, because "keeps its explanation" must not become
 *   "invents one".
 *
 * @module services/runtimes/claude-code/__tests__/refusal-abort-settlement
 */
import { describe, it, expect } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { StreamEvent } from '@dorkos/shared/types';
import { mapSdkMessageWithMedia } from '../media-capture.js';
import { createToolState, stopWasAimedAt } from '../agent-types.js';
import type { AgentSession } from '../agent-types.js';
import { feedProjector } from '../../../session/session-event-normalizer.js';
import { SessionStateProjector } from '../../../session/session-state-projector.js';

const SESSION_ID = 'sess-refusal';

/** The CLI's diagnostic line for an abort, as the binary composes it. */
const EDE_LINE = '[ede_diagnostic] turn aborted (aborted_streaming) stop_reason=refusal';

/**
 * The `result` the CLI sends for an abort that produced no assistant content —
 * the shape a refusal-aborted turn arrives in.
 *
 * @param terminalReason - Which of the CLI's two abort reasons it named
 */
function abortedResult(terminalReason = 'aborted_streaming'): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: terminalReason,
    errors: [EDE_LINE],
    session_id: SESSION_ID,
    uuid: 'result-1',
  } as unknown as SDKMessage;
}

/** A stand-in for the SDK `Query` object identity the stop record is keyed by. */
function makeQuery(): object {
  return { interrupt: () => {} };
}

/**
 * A session whose stop record is the real `WeakSet` the runtime keeps, holding
 * the given query only when DorkOS actually aimed a Stop at it.
 *
 * @param stoppedQuery - The query to record a Stop against, if any
 */
function makeSession(stoppedQuery?: object): AgentSession {
  return {
    sdkSessionId: '',
    lastActivity: 0,
    permissionMode: 'default',
    hasStarted: true,
    pendingInteractions: new Map(),
    eventQueue: [],
    stoppedQueries: stoppedQuery ? new WeakSet([stoppedQuery]) : new WeakSet(),
  } as unknown as AgentSession;
}

/**
 * Run one SDK `result` through the whole chain a real turn takes and hand back
 * the projector it settled.
 *
 * @param result - The SDK message closing the turn
 * @param opts.stopped - Whether DorkOS aimed a Stop at this turn's query
 */
async function settle(
  result: SDKMessage,
  opts: { stopped: boolean }
): Promise<SessionStateProjector> {
  const query = makeQuery();
  const session = makeSession(opts.stopped ? query : undefined);
  const toolState = createToolState();
  // The runtime's own probe, not a hand-written boolean: the intent half is
  // produced by the same call the pump and the resume path make.
  const wasStopped = (): boolean =>
    stopWasAimedAt(session, query as Parameters<typeof stopWasAimedAt>[1]);

  async function* stream(): AsyncGenerator<StreamEvent> {
    // The wrapper, not the bare mapper: `mapSdkMessageWithMedia` is the single
    // call site BOTH dispatch paths share — `executeSdkQuery`'s loop on the
    // resume path and `streamTurnWindow` on the persistent pump — so entering
    // here is entering where a real turn enters. `null` for the attachment
    // store: this turn carries no picture, and the wrapper's media drains are
    // no-ops for a `result`.
    yield* mapSdkMessageWithMedia(null, result, session, SESSION_ID, toolState, wasStopped);
  }

  const projector = new SessionStateProjector(SESSION_ID);
  await feedProjector(projector, stream(), { userMessage: 'write me a thing' });
  return projector;
}

describe('an API refusal that aborted the turn (DOR-1684)', () => {
  it.each(['aborted_streaming', 'aborted_tools'])(
    'settles %s as a failure and keeps its explanation, live and hydrated',
    async (terminalReason) => {
      const projector = await settle(abortedResult(terminalReason), { stopped: false });

      // Live: the operator is told the turn failed, not that they stopped it.
      const status = projector.getStatus();
      expect(status.lifecycle).toBe('error');
      expect(status.lastError).toMatchObject({
        message: EDE_LINE,
        code: 'error_during_execution',
        category: 'execution_error',
      });

      // Hydrated: the same turn read from the durable snapshot, which is the
      // reading that used to come back clean with the failure text gone.
      const snapshot = await projector.buildSnapshot(async () => []);
      expect(snapshot.status.lifecycle).toBe('error');
      expect(snapshot.status.lastError).toMatchObject({ message: EDE_LINE });
    }
  );

  it('still reads an operator Stop as the stop it was', async () => {
    // The direction the in-code comment warns against "fixing" away: the same
    // result shape, the same abort reason, and a Stop on record. The mapper
    // suppresses the error frame and the turn settles interrupted, with no red
    // frame left in the durable record of something a person did on purpose.
    const projector = await settle(abortedResult(), { stopped: true });

    const status = projector.getStatus();
    expect(status.lifecycle).toBe('interrupted');
    expect(status.lastError).toBeNull();

    const snapshot = await projector.buildSnapshot(async () => []);
    expect(snapshot.status.lifecycle).toBe('interrupted');
    expect(snapshot.status.lastError).toBeNull();
  });

  it('reports the intent on the wire, so a hydrating client derives the same answer', async () => {
    // The client mirrors this derivation from the durable stream (DOR-1681), so
    // the record has to BE on the stream rather than only in this process — on
    // the `turn_end` the normalizer closes the window with, which is the event
    // both derivations read.
    const projector = await settle(abortedResult(), { stopped: false });
    const events = projector.replayFrom(0);

    const end = events.find((e) => e.type === 'turn_end');
    expect(end).toMatchObject({ terminalReason: 'aborted_streaming', stopWasRequested: false });
  });

  it('leaves an abort that produced content as interrupted, inventing no failure', async () => {
    // The CLI closes a content-bearing abort as `success`, so there is no error
    // frame and nothing to explain — a turn cut short after it had spoken is
    // interrupted, and promoting it to a crash would be the mirror-image lie.
    const projector = await settle(
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        terminal_reason: 'aborted_streaming',
        result: 'partial answer',
        session_id: SESSION_ID,
        uuid: 'result-2',
      } as unknown as SDKMessage,
      { stopped: false }
    );

    expect(projector.getStatus().lifecycle).toBe('interrupted');
    expect(projector.getStatus().lastError).toBeNull();
  });
});
