/**
 * Handing a run over now (spec `turns-survive-restarts` §3.5, T6): the space
 * face's start for a caller that answers its own asker at once and so must
 * hear what became of the hand-over: a spin-off's first message (its agent is
 * told the new chat's id, or why it did not start) and a message sent from the
 * web (the page is told the chat's id).
 *
 * It saves the run and its `start_turn` exactly as `start()` does, then asks
 * admission and, when admission lets it go, the computer face, in this call
 * rather than on the worker's next pass. Its answer is one of three:
 *
 * - **handed**: the computer face took the run, with what this Mac's launch
 *   path said (the chat's id, the words' place in its queue). The run's
 *   `start_turn` then belongs to the worker, which waits for its `started`.
 * - **waiting**: admission holds the run (a full machine, a full set of web
 *   chats, a paused agent), or the chat turned busy in between. The run waits
 *   with its reason and its place (§4.6), and the worker hands it over when
 *   it may go, as it does every waiting run. Nothing is refused for load.
 * - **refused**: the computer face refused it at the door; the run is
 *   cancelled with the reason, and the answer carries the sentence the launch
 *   path gave, so the asker hears what it heard before.
 *
 * A start refused before anything is saved throws `TurnStartRefusedError` as
 * `start()` does. A hand-over that throws cancels its run (`start_failed`) and
 * rethrows, so a caller's own handling of a launch error is unchanged.
 *
 * **One hand-over at a time.** The saved `start_turn` is due only after
 * {@link HAND_OVER_NOW_GRACE_MS}, so the worker leaves it alone while this call
 * hands it over; should the launch take longer, the worker's own attempt finds
 * the run held and answers `already_held`. Either way one launch happens.
 *
 * @module services/runs/hand-over-now
 */
import type { StartTurnInput, WaitReason } from '@dorkos/shared/turn-port';
import type { HandOverNowAnswer } from '@dorkos/shared/turn-hand-over';
import type { ComputerTurnPort, HandOverResult } from '../session/turn-port/index.js';
import type { admit, AdmissionDeps } from './admission.js';
import type { EffectStore } from './effects/effect-store.js';
import { requestOf } from './effects/handlers/start-turn.js';
import { StartPayloadSchema } from './effects/start-payload.js';
import type { StartTurns } from './effects/start-turns.js';
import type { RunStore, TurnRun } from './run-store.js';
import { chatRunsOf } from './run-view.js';
import type { SpaceTurnPort } from './turn-port.js';

/**
 * How long a run handed over now keeps the worker away from its `start_turn`:
 * long enough for a launch that makes a workspace, short enough that a run
 * whose hand-over was lost (a bug, a throw outside it) is soon picked up.
 */
export const HAND_OVER_NOW_GRACE_MS = 60_000;

/** What a hand-over now needs: the record's own parts, as `createRunRecord` builds them. */
export interface HandOverNowDeps {
  runs: RunStore;
  effects: EffectStore;
  starts: StartTurns;
  port: SpaceTurnPort;
  computer: () => ComputerTurnPort | undefined;
  /** Admission's sources and admission itself. */
  admission: Omit<AdmissionDeps, 'runs'>;
  admit: typeof admit;
  /** Every slot a run takes when admission lets it go (the scheduler's, the web's). */
  slots: { claim: (run: Pick<TurnRun, 'id' | 'origin'>) => void; release: (runId: string) => void };
  now: () => number;
}

/**
 * Save a run and hand it over now. See the module documentation.
 *
 * @param deps - The run record's parts.
 * @param input - The start, as `start()` takes it.
 * @param opts.runId - The run's id, when the caller minted it.
 * @throws {TurnStartRefusedError} When the start is refused before anything is saved.
 */
export async function handOverNow(
  deps: HandOverNowDeps,
  input: StartTurnInput,
  opts: { runId?: string } = {}
): Promise<HandOverNowAnswer> {
  const saved = deps.port.start(input, {
    ...opts,
    handOverAt: deps.now() + HAND_OVER_NOW_GRACE_MS,
  });
  const { runId } = saved;
  const run = deps.runs.get(runId)!;
  const waiting = (reason?: WaitReason): HandOverNowAnswer => {
    if (reason !== undefined) deps.starts.waiting(runId, reason);
    toWorker(deps, runId);
    const view = deps.runs.get(runId);
    // Its place as the chat's stream shows it (§4.6): behind the chat's keyed
    // starts, and behind a new direct chat's messages sent before it (DOR-5512).
    const shown = chatRunsOf(deps.runs, deps.effects, run.sessionId).find((r) => r.id === runId);
    return {
      kind: 'waiting',
      runId,
      ...(view?.waitReason ? { waitReason: view.waitReason } : {}),
      queuePosition: shown?.queuePosition ?? saved.queuePosition,
    };
  };
  const start = StartPayloadSchema.parse(deps.effects.openStartOf(runId)?.payload);
  const verdict = deps.admit({ ...run, origin: run.origin! }, start, {
    runs: deps.runs,
    ...deps.admission,
  });
  if ('wait' in verdict) return waiting(verdict.wait);
  const computer = deps.computer();
  if (!computer) return waiting();
  // Nothing awaits between admission's answer and the slots' claim.
  deps.slots.claim(run);
  let handed: HandOverResult;
  try {
    const request = requestOf(
      run,
      run.origin!,
      deps.port.wordsOf(run) ?? input.content,
      start,
      verdict
    );
    handed = computer.handOver
      ? await computer.handOver(request)
      : { answer: await computer.start(request) };
  } catch (err) {
    deps.slots.release(runId);
    deps.starts.cancel(runId, 'start_failed');
    throw err;
  }
  const { answer } = handed;
  if ('accepted' in answer) {
    toWorker(deps, runId);
    return { kind: 'handed', runId, ...(handed.receipt ? { receipt: handed.receipt } : {}) };
  }
  deps.slots.release(runId);
  if (handed.capFull) return waiting('machine_full');
  if (answer.refused === 'chat_busy') return waiting('chat_busy');
  if (answer.refused === 'already_held') return waiting();
  deps.starts.cancel(runId, answer.refused);
  return {
    kind: 'refused',
    runId,
    reason: answer.refused,
    ...(handed.refusal ? { refusal: handed.refusal } : {}),
  };
}

/**
 * The run's `start_turn` is the worker's from now: due at once, so a waiting
 * run is looked at again under the worker's own backoff and wakes, and a run
 * handed over is followed until its `started`. An effect the worker already
 * holds, or one already ended, is left as it is.
 */
function toWorker(deps: Pick<HandOverNowDeps, 'effects' | 'now'>, runId: string): void {
  if (deps.effects.openStartOf(runId)?.state === 'pending') {
    deps.effects.reopenStartOf(runId, deps.now());
  }
}
