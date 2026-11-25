/**
 * Admission (spec `turns-survive-restarts` §3.5, DOR-5157): the one place
 * that decides whether a waiting run may be handed to a computer now, or
 * waits, and why. The `start_turn` handler asks it before the computer face
 * is called, so **waiting is a space-side answer**: the computer face (and
 * later the wire) has no "waiting" answer, only accepted or refused.
 *
 * It applies only what exists today, in the spec's order:
 *
 * 1. **The agent is paused.** A person's own chat goes on, so the computer
 *    face refuses it as `agent_paused` and the person sees today's error.
 *    Any other run waits (`paused`) until the pause is lifted.
 * 2. **The chat is busy.** A run whose words stay at their source waits
 *    (`chat_busy`) while the chat has a live run, and is woken when that run
 *    lets go. On a Mac a run whose words wait in the composer skips this: the
 *    dispatcher queues it as a row a person can see (§4.7).
 * 3. **The machine is full.** A run nobody typed into waits (`machine_full`)
 *    while every slot under `runtimes.maxAgentChats` is taken, and is woken
 *    when a run lets go of one. The check and the slot's claim happen in one
 *    synchronous step: nothing awaits between this answer and the computer
 *    face's own claim at the top of `dispatchSessionMessage`.
 * 4. **The account** the caller hinted passes through as `accountRef`
 *    (DOR-5190 replaces the choice).
 *
 * The rest have a slot and no rule yet: an agent busy in another room (T10,
 * rooms' own callers), the scheduler's cap (T12), the memory budget
 * (DOR-5192), a playbook (DOR-5187, absent rather than `null` on the port).
 *
 * @module services/runs/admission
 */
import {
  personTyped,
  wordsWaitInComposer,
  type TurnOrigin,
  type WaitReason,
} from '@dorkos/shared/turn-port';
import type { StartPayload } from './effects/start-payload.js';
import type { RunStore, TurnRun } from './run-store.js';

/** Admission's answer for one run. */
export type AdmissionVerdict =
  | { go: true; accountRef?: string }
  | {
      wait: WaitReason;
      /** Epoch ms to look again, when admission knows one; else the handler's backoff. */
      retryAt?: number;
    };

/** What admission reads. Each is today's source for its check (§3.5). */
export interface AdmissionDeps {
  runs: RunStore;
  /** Whether the agent a turn is for is paused: by Mesh id, else by its folder. */
  isPaused: (agentId: string | null, cwd: string) => boolean;
  /** Whether every launch slot under `runtimes.maxAgentChats` is taken. */
  machineFull: () => boolean;
}

/**
 * Whether a run counts toward the launch cap: every turn nobody typed into
 * (§3.5; `countsTowardLaunchCap` in `launch-session.ts`).
 *
 * @param origin - What started the run.
 */
export function countsTowardCap(origin: TurnOrigin): boolean {
  return !personTyped(origin);
}

/**
 * Decide whether a waiting run may be handed over now.
 *
 * @param run - The run, `queued`, with its origin.
 * @param start - Its `start_turn` payload: where it runs and the account it hinted.
 * @param deps - Today's sources.
 * @returns `go`, with what to hand over, or why it waits.
 */
export function admit(
  run: TurnRun & { origin: TurnOrigin },
  start: Pick<StartPayload, 'cwd' | 'accountHint'>,
  deps: AdmissionDeps
): AdmissionVerdict {
  if (!personTyped(run.origin) && deps.isPaused(run.agentId, start.cwd)) return { wait: 'paused' };
  if (!wordsWaitInComposer(run.origin)) {
    const live = deps.runs.liveRunOf(run.sessionId);
    if (live && live.id !== run.id) return { wait: 'chat_busy' };
  }
  if (countsTowardCap(run.origin) && deps.machineFull()) return { wait: 'machine_full' };
  return {
    go: true,
    ...(start.accountHint !== undefined ? { accountRef: start.accountHint } : {}),
  };
}
