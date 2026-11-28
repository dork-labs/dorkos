/**
 * The run record's own shapes (spec `turns-survive-restarts` §4.1): a run as
 * the store answers it, and what `ending_detail` holds. Kept apart from the
 * store so the store stays about the record's rules; `run-store.ts`
 * re-exports them.
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
  settledAt: string | null;
}
