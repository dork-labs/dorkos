/**
 * `start_turn` (spec `turns-survive-restarts` §6.2, DOR-5157): the effect that
 * hands a run to the computer face, saved with the run by `start()`.
 *
 * **Repeatable until the run records `started`, then never again.** The
 * handler leases the effect and keeps it leased (`await`) until the run's
 * `started`, `superseded` or `cancelled`, each of which ends it in its own
 * transaction (`start-turns.ts`). Repeating a hand-over before `started` is
 * safe: no `started` fact means the runtime never saw the words.
 *
 * **Never handed over twice.** A run whose launch is under way (`starting`)
 * waits for its fact. A run whose words are already in the queue
 * (`queue_message_id` set and its row present) is not handed over again, so a
 * restart cannot put its words in the queue twice; one whose row is gone is
 * cancelled. A repeat the computer side already holds answers `already_held`,
 * and the run keeps its status.
 *
 * **Waiting** is admission's answer (`admission.ts`), written on the run
 * (transition 3) and retried after the backoff of §6.1 (1 s, 5 s, 30 s,
 * 2 min, then every 10 min), without counting attempts, and woken early when
 * the run it waits on lets go. A `chat_busy` refusal from the computer face
 * (the chat turned busy between admission and the hand-over) waits the same
 * way. Every other refusal cancels the run with its reason (§3.1). The run's
 * `notAfter` bounds all of it: past it the run is cancelled as `expired`, and
 * one still waiting in the dispatcher is withdrawn unless its launch has begun.
 *
 * **A hand-over that keeps failing** (the computer face throws) retries with
 * the worker's backoff, and on its last attempt cancels the run as
 * `start_failed`, so no run waits with nothing left to hand it over. A source
 * whose reader is not registered yet (early in a boot) is such a failure, not
 * words that are gone.
 *
 * **Its own writes.** The handler writes what it decided (a cancel, a wait)
 * itself, so a hand-over that outlives the worker's patience still lands:
 * the worker keeps an over-long `start_turn` leased (`onTimeout: 'await'`).
 *
 * @module services/runs/effects/handlers/start-turn
 */
import {
  wireOriginOf,
  type TurnStartAnswer,
  type TurnStartRequest,
} from '@dorkos/shared/turn-port';
import type { ComputerTurnPort } from '../../../session/turn-port/index.js';
import { admit, type AdmissionDeps, type AdmissionVerdict } from '../../admission.js';
import type { RunStore, TurnRun } from '../../run-store.js';
import type { SpaceTurnPort } from '../../turn-port.js';
import type { TurnEffect } from '../effect-store.js';
import { StartPayloadSchema, type StartPayload } from '../start-payload.js';
import { busyRetriesOf, type StartTurns } from '../start-turns.js';
import {
  EFFECT_MAX_ATTEMPTS,
  failuresOf,
  retryDelayMs,
  type EffectAnswer,
  type EffectContext,
  type EffectHandler,
} from '../worker.js';

/** What the handler needs. */
export interface StartTurnDeps {
  runs: RunStore;
  starts: StartTurns;
  port: SpaceTurnPort;
  /** The computer face; `undefined` until startup wired it (the attempt then retries). */
  computer: () => ComputerTurnPort | undefined;
  /** Whether a queue row still holds its words. */
  queueRowExists: (queueMessageId: string) => boolean;
  /** Admission's sources. */
  admission: Omit<AdmissionDeps, 'runs'>;
  /** Admission itself; tests stand in for a chat turning busy right after it. */
  admit?: typeof admit;
}

/** The handler, bound to what it needs. */
export function startTurnHandler(deps: StartTurnDeps): EffectHandler {
  return {
    onTimeout: 'await',
    handle: (effect, ctx) => handOver(deps, effect, ctx),
    onExpired: (effect) => {
      if (effect.runId !== null) deps.starts.cancel(effect.runId, 'expired');
    },
    checkHeld: (effect) => {
      // Waiting for a launch this process no longer holds (its plan was
      // dropped without a word to the record): hand it over again, now.
      const run = effect.runId === null ? undefined : deps.runs.get(effect.runId);
      if (run?.status !== 'queued' || deps.computer()?.holds(run.id) !== false) return;
      // A row in the queue is the queue's to start: this effect is done.
      if (run.queueMessageId !== null) {
        if (deps.queueRowExists(run.queueMessageId)) {
          deps.starts.handOffToQueue(run.id);
        }
        return;
      }
      deps.starts.reopen(run, 0);
    },
    expireHeld: (effect) => {
      const run = effect.runId === null ? undefined : deps.runs.get(effect.runId);
      if (!run || run.status !== 'queued') return;
      // Waiting in the dispatcher: withdrawn, unless its launch has begun, in
      // which case it ends as that launch ends it (§4.7).
      if (deps.computer()?.withdraw(run.id) === false) return;
      deps.starts.expire(run.id);
    },
  };
}

/** One hand-over attempt. */
async function handOver(
  deps: StartTurnDeps,
  effect: TurnEffect,
  ctx: EffectContext
): Promise<EffectAnswer> {
  const run = effect.runId === null ? undefined : deps.runs.get(effect.runId);
  if (!run) return { kind: 'drop', reason: 'run_gone' };
  // A launch under way ends this with its fact; any other status already did.
  if (run.status === 'starting') return { kind: 'await' };
  if (run.status !== 'queued') return { kind: 'done' };
  if (run.queueMessageId !== null) {
    // Its words are a queue row: the queue starts it (the pump, adoption, a
    // re-arm), so this effect's work is done rather than awaited forever.
    if (deps.queueRowExists(run.queueMessageId))
      return { kind: 'done', outcome: { inQueue: true } };
    deps.starts.cancel(run.id, 'removed');
    return { kind: 'done' };
  }
  // Its source's reader registers during boot; until then, try again later.
  if (!deps.port.canReadWords(run)) throw new Error(`No reader for ${run.sourceRef} yet`);
  const words = deps.port.wordsOf(run);
  const start = StartPayloadSchema.safeParse(effect.payload);
  if (words === undefined || run.origin === null || !start.success) {
    deps.starts.cancel(run.id, 'start_lost');
    return { kind: 'done' };
  }
  const verdict = (deps.admit ?? admit)({ ...run, origin: run.origin }, start.data, {
    runs: deps.runs,
    ...deps.admission,
  });
  if ('wait' in verdict) return waitFor(deps, run, effect, ctx, verdict);
  const answer = await handTo(deps, effect, requestOf(run, run.origin, words, start.data, verdict));
  if (answer === undefined) return { kind: 'done' };
  if ('accepted' in answer || answer.refused === 'already_held') return { kind: 'await' };
  if (answer.refused === 'chat_busy') return waitFor(deps, run, effect, ctx, { wait: 'chat_busy' });
  deps.starts.cancel(run.id, answer.refused);
  return { kind: 'done' };
}

/**
 * Ask the computer face. A throw retries with the worker's backoff; on the
 * last attempt the run is cancelled instead (`start_failed`), so it never
 * waits with nothing left to hand it over.
 *
 * @returns The answer, or `undefined` when the run was cancelled here.
 */
async function handTo(
  deps: StartTurnDeps,
  effect: TurnEffect,
  request: TurnStartRequest
): Promise<TurnStartAnswer | undefined> {
  try {
    const computer = deps.computer();
    if (!computer) throw new Error('The computer face is not wired yet');
    return await computer.start(request);
  } catch (err) {
    // Only the attempts that threw count; a wait for a busy chat is not one.
    if (failuresOf(effect) + 1 < EFFECT_MAX_ATTEMPTS) throw err;
    deps.starts.cancel(request.runId, 'start_failed');
    return undefined;
  }
}

/** Write the run's wait (transition 3) and hand the effect back until it may go again. */
function waitFor(
  deps: StartTurnDeps,
  run: TurnRun,
  effect: TurnEffect,
  ctx: EffectContext,
  verdict: Extract<AdmissionVerdict, { wait: unknown }>
): EffectAnswer {
  deps.starts.waiting(run.id, verdict.wait);
  const busyRetries = busyRetriesOf(effect) + 1;
  const retryAt = verdict.retryAt ?? ctx.now() + retryDelayMs(busyRetries);
  const outcome = { busyRetries, waiting: verdict.wait, failures: failuresOf(effect) };
  ctx.release(retryAt, outcome);
  return { kind: 'wait', retryAt, outcome };
}

/** The computer face's request: the run's identity, its words inline, and what admission decided. */
function requestOf(
  run: TurnRun,
  origin: NonNullable<TurnRun['origin']>,
  words: string,
  start: StartPayload,
  verdict: Extract<AdmissionVerdict, { go: true }>
): TurnStartRequest {
  const { accountHint: _accountHint, ...options } = start;
  return {
    runId: run.id,
    attempt: run.attempt,
    ...(run.continuesRunId !== null ? { continuesRunId: run.continuesRunId } : {}),
    sessionId: run.sessionId,
    ...(run.agentId !== null ? { agentId: run.agentId } : {}),
    content: words,
    origin,
    wireOrigin: wireOriginOf(origin),
    ...stripUndefined(options),
    ...(verdict.accountRef !== undefined ? { accountRef: verdict.accountRef } : {}),
  };
}

/** The defined fields of an object: the port's objects are strict and carry no `undefined`. */
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
}
