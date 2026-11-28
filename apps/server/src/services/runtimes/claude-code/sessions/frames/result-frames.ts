/**
 * Reading and making the `result` frames the turn windower closes windows on:
 * which messages a `result` answers, what it says about the turn it ends, and
 * the synthetic `result`s DorkOS writes when a turn has to end without one.
 *
 * Split out of `../session-turn-windows.ts`, which is the only reader and is
 * over the file-size limit. The rules that act on the answers stay there.
 *
 * @module services/runtimes/claude-code/sessions/frames/result-frames
 */
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { isInterruptedTerminalReason } from '@dorkos/shared/schemas';
import type { PumpCrash } from '../session-pump-contract.js';

/**
 * Whether a `result` reports a FAILED or cut-short turn, which closes its window
 * at once even when the window carried nothing (spec `warm-process-lifecycle`
 * D5). An error has already said what went wrong, and a Stop must not wait.
 *
 * @param message - The `result` about to close a window
 */
export function closesWithAFailure(message: SDKMessage): boolean {
  return (message as { is_error?: unknown }).is_error === true || closesAnAbortedTurn(message);
}

/** Why an empty dispatched window closed on its `result` at once rather than waiting. */
export type ImmediateCloseReason = 'failure-result' | 'aborted' | 'local-command';

/**
 * Name the reason an empty dispatched window closed on its `result` at once.
 *
 * @param result - The `result` that closed it
 */
export function immediateCloseReason(result: SDKMessage): ImmediateCloseReason {
  if (closesAnAbortedTurn(result)) return 'aborted';
  if (readTurnProvenance(result).localCommand !== undefined) return 'local-command';
  return 'failure-result';
}

/**
 * Every id an SDK `result` says it answers, or an empty list when it names none.
 *
 * **The UNION of both fields, never one instead of the other.**
 * `user_message_uuids` (claude-agent-sdk 0.3.259) is the full set a coalesced
 * turn consumed and it LEADS, because its order is the SDK's own consumption
 * order and this is the only field that can carry more than one id. The singular
 * `user_message_uuid` is then appended if the list did not already contain it.
 *
 * Appending rather than choosing is the whole point. The SDK documents the
 * plural field as "always contains user_message_uuid", so on a healthy producer
 * the append is a no-op and the union costs nothing. What it buys is the
 * unhealthy one: a producer whose two fields DISAGREE would, under a
 * prefer-the-list rule, have its singular id silently discarded — and an id this
 * layer drops is an id that cannot close the window it belongs to, which is
 * exactly the stranding DOR-1294 was. A spurious extra id is the cheaper
 * failure by a wide margin: it correlates nothing (no window holds it, nothing
 * sent it) and lands in the runtime-window branch, where it is said out loud.
 *
 * An empty or absent list therefore needs no special case — it simply
 * contributes nothing, and the singular carries the result on its own. That is
 * the fallback the SDK prescribes for delivery-failure results, zeroed results,
 * and older producers.
 *
 * Read defensively off the message rather than by narrowing to the branch that
 * declares the fields, and keep it that way. Until claude-agent-sdk 0.3.268 only
 * `SDKResultSuccess` declared `user_message_uuid`; at 0.3.268 `SDKResultError`
 * declares it too. Narrowing would have made that vendor change an outage here
 * instead of a comment, and nothing says the fields cannot move again.
 *
 * @param message - The `result` being correlated
 */
export function readAnsweredIds(message: SDKMessage): readonly string[] {
  const ids: string[] = [];
  const add = (id: unknown): void => {
    if (typeof id !== 'string' || id.length === 0 || ids.includes(id)) return;
    ids.push(id);
  };
  const all = (message as { user_message_uuids?: unknown }).user_message_uuids;
  if (Array.isArray(all)) for (const id of all) add(id);
  add((message as { user_message_uuid?: unknown }).user_message_uuid);
  return ids;
}

/**
 * How many of this session's sends the CLI still had QUEUED when it produced
 * this `result` (`queued_turn_count`, claude-agent-sdk 0.3.243), or `undefined`
 * when it did not say.
 *
 * A positive count is the CLI stating, about its own queue, that another turn
 * runs without anybody sending anything else — which is the only thing
 * {@link continuationOutlook} acts on. A `0` and an ABSENT field are treated
 * identically there and deliberately so; read that function for why a `0` is
 * not evidence of an empty queue.
 *
 * Anything that is not a finite count of zero or more is read as ABSENT: a
 * negative is not a queue depth, and inventing a meaning for it would be
 * inventing evidence. Same reason the value is read off the message rather than
 * by narrowing to a branch — see {@link readAnsweredIds}.
 *
 * That normalization is **contract hygiene, not behaviour**, and saying so is
 * the honest thing: today's one reader asks `> 0`, so a negative would take the
 * same branch as an absent field whether this rejected it or not. No test can
 * therefore prove the guard from the outside, and none pretends to. It is here
 * so this function's promise — a count of zero or more, or nothing — is true for
 * whoever reads it next, rather than true only for the caller that happens to
 * exist now.
 *
 * @param message - The `result` closing, or about to close, a window
 */
export function readQueuedTurnCount(message: SDKMessage): number | undefined {
  const queued = (message as { queued_turn_count?: unknown }).queued_turn_count;
  if (typeof queued !== 'number' || !Number.isFinite(queued) || queued < 0) return undefined;
  return queued;
}

/**
 * What a `result` says about a turn DorkOS did not ask for — the fields that
 * explain a synthetic `origin: 'runtime'` window instead of leaving it a
 * mystery (claude-agent-sdk 0.3.268).
 *
 * All three are diagnostics. None of them changes which window closes, and
 * `resultIndex` in particular must never become an ordinal this module counts:
 * correlation here is by id and never by position, which is the one rule the
 * module doc puts above the others.
 *
 * @param message - The `result` about to open or close a window
 */
export function readTurnProvenance(message: SDKMessage): {
  /**
   * Set ONLY on the automatic re-run of a turn a host restart interrupted, and
   * carrying why (`host_draining`, `checkpoint_restore`, …, else
   * `'interrupted_turn'`). A `result` carrying this answered a turn nobody in
   * this session asked for a second time, which is precisely the case the
   * runtime window exists for — so when it is present, the window is explained
   * rather than merely reported.
   */
  resumeReason?: string;
  /** The slash command a turn ran without ever entering the model loop. */
  localCommand?: string;
  /** This result's delivery sequence within the run; a gap means one was lost. */
  resultIndex?: number;
} {
  const result = message as {
    resume_reason?: unknown;
    local_command?: unknown;
    result_index?: unknown;
  };
  return {
    ...(typeof result.resume_reason === 'string' && result.resume_reason.length > 0
      ? { resumeReason: result.resume_reason }
      : {}),
    ...(typeof result.local_command === 'string' && result.local_command.length > 0
      ? { localCommand: result.local_command }
      : {}),
    ...(typeof result.result_index === 'number' ? { resultIndex: result.result_index } : {}),
  };
}

/**
 * Whether this `result` closes a turn that was CUT SHORT — by a person, or by
 * anything else that aborted it (DOR-1319).
 *
 * **Shape only, deliberately, and this is the one place that is enough.** The
 * terminal reason says a turn was aborted and never by whom (see
 * `sdk/sdk-error-mapping.ts`, which ANDs the same shape with DorkOS's own stop
 * record before it will drop an error frame). This layer cannot ask the same
 * question — it never sees the stop request and holds no session — but it does
 * not need to, because of what it does with the answer: it skips an accounting
 * fetch. A false positive costs one turn's context breakdown, which the next
 * window's close refetches. Nothing about the turn's honesty rides on it, so
 * the cheaper question is the right one HERE and would be the wrong one there.
 *
 * Read defensively, exactly as {@link readAnsweredIds} is, and for the same
 * reason: the field is not declared on every `result` member.
 *
 * @param message - The `result` closing a window
 */
export function closesAnAbortedTurn(message: SDKMessage): boolean {
  const reason = (message as { terminal_reason?: unknown }).terminal_reason;
  return typeof reason === 'string' && isInterruptedTerminalReason(reason);
}

/**
 * The `result` for a process a STOP killed — the same synthetic close as
 * `crashResult` (`../diagnostics/session-crash-result.ts`), told honestly
 * (DOR-1302).
 *
 * A Stop the CLI neither acks nor refuses escalates to `query.close()`
 * (`session-store.ts`), and on the pump that close is a process death like any
 * other: the same seam, the same abandoned window. What differs is who asked.
 * Settling it as a crash reported the operator's own Stop as the agent falling
 * over — a red frame in the durable record of a turn they ended on purpose.
 *
 * **It carries the terminal the CLI never got to send.** `'interrupted'` is
 * DorkOS's own reason for exactly this case, the one the resume path already
 * supplies from `message-sender.ts` when a close ends its stream with no
 * `result` at all. The mapper reads it as an abort, ANDs it with DorkOS's stop
 * record, and therefore drops the error frame and settles the turn
 * `interrupted` — one rule for a stopped turn, wherever the turn was running.
 *
 * The subtype stays `error_during_execution`, matching what the CLI itself
 * sends for a stop it DID ack: the turn did not finish, and the suppression
 * above is what keeps that from reading as a failure.
 *
 * @param crash - What the pump observed when the process went
 */
export function stoppedResult(crash: PumpCrash): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    terminal_reason: 'interrupted',
    errors: ['This reply was stopped, so DorkOS ended the agent that was writing it.'],
    uuid: `stopped-${crash.sessionId}`,
    session_id: crash.sessionId,
  } as unknown as SDKMessage;
}

/**
 * The `result` a turn never produced, for a window that has to be closed anyway.
 *
 * Same shape and same reasoning as `crashResult`: a non-success subtype
 * maps to a typed `error` event and `feedProjector`'s error latch settles the
 * window as `turn_end{terminalReason:'error'}`. The wording is the operator's,
 * not the SDK's, because nothing in the SDK ever said this — DorkOS is the one
 * declaring the turn over (DOR-1294).
 *
 * @param sessionId - The session whose window is being closed
 */
export function strandedResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'error_during_execution',
    is_error: true,
    errors: ['The agent never finished this turn, so DorkOS ended it to accept the next message.'],
    uuid: `stranded-${sessionId}`,
    session_id: sessionId,
  } as unknown as SDKMessage;
}

/**
 * The field DorkOS sets on a synthetic `result` that closes a window in which no
 * model was called. The result mapper reads it and reports the turn's own cost
 * as `0`, so a turn meter (`core/turn-power/teammate-turn-cost.ts`) counts the
 * turn as free rather than at its estimate for a turn that reported no cost.
 * Never set by the CLI.
 */
export const NO_MODEL_CALL_FIELD = 'dorkos_no_model_call';

/**
 * The quiet `result` that ends a window opened only to show an ask (DOR-2698).
 *
 * A helper still working after the reply can ask a person to approve a tool
 * call. The windower opens a window so that card reaches the chat, and closes
 * it once nobody is being waited on. Nothing failed and the CLI ended no turn,
 * so this is a plain success: it settles the turn `turn_end` with no error, and
 * a card a person has not answered yet stays pending in the session's state.
 * No model was called in it, so it says so ({@link NO_MODEL_CALL_FIELD}).
 *
 * @param sessionId - The session whose ask window is closing
 */
export function askSettledResult(sessionId: string): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '',
    uuid: `ask-settled-${sessionId}`,
    session_id: sessionId,
    [NO_MODEL_CALL_FIELD]: true,
  } as unknown as SDKMessage;
}
