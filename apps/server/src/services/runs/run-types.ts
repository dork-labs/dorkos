/**
 * The run record's own shapes (spec `turns-survive-restarts` §4.1): a run as
 * the store answers it, what `ending_detail` holds, what the store's writes
 * take, and the one error they throw. Kept apart from the store so the store
 * stays about the record's rules; `run-store.ts` re-exports them.
 *
 * @module services/runs/run-types
 */
import type {
  AttemptReason,
  RunEnding,
  RunStatus,
  TurnOrigin,
  WaitReason,
} from '@dorkos/shared/turn-port';
import type { TurnRunRow } from '@dorkos/db';
import type { InterruptReceipt, SessionLaunchWarning } from '@dorkos/shared/schemas';

/** One stop asked of a run, written when it is asked (§4.4). */
export interface RunStopRequest {
  /** When it was asked, ISO 8601. */
  at: string;
  /** Who asked, as a `dork:` reference, when the asker is known. */
  by?: string;
  /** Which door asked: the Stop button or a pause. */
  via: 'stop' | 'pause';
  /** What its receipt said, once it came. */
  outcome?: InterruptReceipt['outcome'];
}

/**
 * What `ending_detail` holds (§4.1): never transcript text, only what DorkOS
 * observed about how the run ended or why it never started.
 */
export interface RunEndingDetail {
  /** Every stop asked of the run, in order. */
  stopRequests?: RunStopRequest[];
  /** The runtime's own words when it refused the turn (DOR-2994). */
  refusal?: string;
  /** The run ended before the runtime read its words, so nobody knows if it did. */
  delivery?: 'unknown';
  /** Why a run that never started was cancelled. */
  cancelledBecause?: string;
  /** A private message's attempt whose outcome nobody can know (§4.7). */
  outcomeUnknown?: true;
  /** What recovery decided follows the run after a restart (§7.3), with its line. */
  restart?: RestartDecision;
}

/**
 * What recovery decided follows a run a restart ended (§7.3, step 4), which
 * is also the line a person sees about it (§7.4):
 *
 * - `continued`: a new turn in the same chat picks it back up;
 * - `not_resumable`: its runtime cannot pick a turn back up, or its last sign
 *   of life is past the age bound, so it stopped;
 * - `waited_on_you`: it was waiting on the person's answer;
 * - `chain_cap`: its turn was already picked back up as often as it may be;
 * - `quiet`: nothing continues and no line is owed (a stop someone asked
 *   for, a turn nobody asked for, words the runtime may not have read, a
 *   run of this very boot).
 */
export type RestartDecision =
  'continued' | 'not_resumable' | 'waited_on_you' | 'chain_cap' | 'quiet';

/** One piece of background work that died with a run (§7.4), as `lost_background_json` holds it. */
export interface LostBackgroundWork {
  /** What it was: a background shell, a helper, a monitor, or work of no known kind. */
  kind: string;
  /** Its label, DorkOS's own words or the runtime's label for it, never transcript text. */
  label: string;
}

/** A run as the store answers it: the record's fields, in the port's types. */
export interface TurnRun {
  id: string;
  /** The chat, by the id its queue rows are kept under. */
  sessionId: string;
  chatSeq: number;
  chainId: string;
  agentId: string | null;
  /** What started it; `null` for a runtime's own turn or an unrecorded caller. */
  origin: TurnOrigin | null;
  openedBy: 'caller' | 'runtime' | 'recovery';
  status: RunStatus;
  waitReason: WaitReason | null;
  attempt: number;
  attemptReason: AttemptReason;
  /** The dead run this one continues after a restart (§7.3), if any. */
  continuesRunId: string | null;
  queueMessageId: string | null;
  /** Where the words wait when they are not in the queue (`<kind>:<id>`, §4.1). */
  sourceRef: string | null;
  /** Epoch ms: a run still waiting past this is cancelled as `expired`. */
  notAfter: number | null;
  /** What the launch owed a person to know, from its `started` fact (T3 shows them). */
  warnings: SessionLaunchWarning[];
  runtime: string | null;
  runtimeTurnRef: number | null;
  turnBindingId: string | null;
  ownerEpoch: string | null;
  leaseUntil: number | null;
  waitingOnPerson: boolean;
  ending: RunEnding | null;
  endingDetail: RunEndingDetail;
  createdAt: string;
  startedAt: string | null;
  deliveredAt: string | null;
  endedAt: string | null;
  /** When recovery decided what follows this run; empty until it has. */
  recoveryDecidedAt: string | null;
  /** The key its source made it under (§6.4), when it has one. */
  startKey: string | null;
  /** The background work that died with it (§7.4). */
  lostBackground: LostBackgroundWork[];
  settledAt: string | null;
}

/**
 * Whether a run's ending waits on recovery before anything may follow it: a
 * `process_died` or `shutdown` ending recovery has not decided yet (§7.1). Such
 * a run stays `ended`, so the boot that decides it can still add the effects
 * of its decision (§7.3, step 4).
 *
 * @param run - An `ended` run.
 */
export function isUndecided(run: Pick<TurnRun, 'ending' | 'recoveryDecidedAt'>): boolean {
  return (
    (run.ending === 'process_died' || run.ending === 'shutdown') && run.recoveryDecidedAt === null
  );
}

/** Thrown for a status change the transition table does not hold. */
export class IllegalRunTransitionError extends Error {
  /**
   * Name the run and the pair refused.
   *
   * @param runId - The run.
   * @param from - Its status, or `null` for a run being created.
   * @param to - The status asked for.
   */
  constructor(
    readonly runId: string,
    readonly from: RunStatus | null,
    readonly to: RunStatus
  ) {
    super(`Run ${runId} may not move from ${from ?? '(none)'} to ${to}`);
    this.name = 'IllegalRunTransitionError';
  }
}

/** What {@link RunStore.create} needs. */
export interface NewRun {
  /** The id, when the computer side minted it (a runtime's own turn); else minted here. */
  id?: string;
  chatKey: string;
  /** `queued` (transition 1) or `running` (transition 2, a runtime's own turn). */
  status: 'queued' | 'running';
  openedBy: TurnRun['openedBy'];
  origin: TurnOrigin | null;
  queueMessageId?: string;
  /** A caller on the turn port: where its words wait, and its deadline. */
  sourceRef?: string;
  notAfter?: number;
  agentId?: string;
  runtime?: string;
  runtimeTurnRef?: number;
  /** The key its source made it under (§6.4): a second create with it fails on the unique index. */
  startKey?: string;
  /** A continuation after a restart (§7.3, step 8): the dead run it picks back up. */
  continues?: Pick<TurnRun, 'id' | 'chainId' | 'attempt'>;
}

/** The columns a status change may also set. */
export type RunPatch = Partial<
  Pick<
    TurnRunRow,
    | 'waitReason'
    | 'runtime'
    | 'runtimeTurnRef'
    | 'turnBindingId'
    | 'ownerEpoch'
    | 'leaseUntil'
    | 'waitingOnPerson'
    | 'ending'
    | 'startedAt'
    | 'deliveredAt'
    | 'endedAt'
    | 'settledAt'
    | 'agentId'
    | 'queueMessageId'
    | 'warningsJson'
    | 'lostBackgroundJson'
    | 'recoveryDecidedAt'
  >
> & { endingDetail?: RunEndingDetail };

/** Options for {@link RunStore}. */
export interface RunStoreOptions {
  /** This process's boot epoch (§6.1): the owner of every run it starts. */
  epoch: string;
  /** The clock, epoch ms. Injected by tests. */
  now?: () => number;
  /**
   * Whether this process still holds the in-memory owner of one of its live
   * runs: a launch under way, an open turn, a runtime's own turn. A live run
   * this boot owns with no such owner is retired like a dead boot's (a write
   * that failed left it live); absent, every run this boot owns counts as held.
   */
  ownerHolds?: (runId: string) => boolean;
  /**
   * Called inside the transaction of every move to `ended`, with the run as
   * stored after the move: where the run's follow-up effects are written, so
   * they commit or roll back with the ending that causes them (§6.1,
   * "Writing"). A throw rolls the move back.
   */
  onEnded?: (run: TurnRun) => void;
  /**
   * Called inside the transaction of every move, after {@link onEnded}, with
   * the run as stored and the status it left: where a run's `start_turn`
   * settles, goes back to `pending`, or wakes its chat's waiting starts (§6.2).
   */
  onMoved?: (run: TurnRun, from: RunStatus) => void;
  /**
   * Called when a chat's runs read differently without a status move (§4.6,
   * `run_update`): a run created, a column annotated, runs moved to another
   * chat, or {@link noteChatChanged}. Inside the write's transaction; with the
   * chat, by the id its queue rows are kept under.
   */
  onChanged?: (chatKey: string) => void;
}
