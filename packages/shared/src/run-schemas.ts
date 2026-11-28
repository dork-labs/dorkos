/**
 * The run record's words and the view of a chat's runs every device reads
 * (spec `turns-survive-restarts` §4.3, §4.4, §4.6, DOR-5212).
 *
 * A leaf module (zod and the launch-warning schema only), so the session
 * stream can carry runs without pulling the turn port's contract into every
 * client. `turn-port.ts` re-exports the three vocabularies below.
 *
 * The view holds no words of a turn: a run and its line, never what was said
 * (spec §4.1). A restored draft's words stay in its queue row.
 *
 * @module shared/run-schemas
 */
import { z } from 'zod';
import { extendZodWithOpenApiOnce } from './zod-openapi.js';
import { SessionLaunchWarningSchema } from './session-launch-schemas.js';

extendZodWithOpenApiOnce();

/** The run record's eight statuses (spec §4.3). */
export const RunStatusSchema = z
  .enum(['queued', 'starting', 'started', 'running', 'ended', 'settled', 'cancelled', 'superseded'])
  .openapi('RunStatus');

/** A run's status. See {@link RunStatusSchema}. */
export type RunStatus = z.infer<typeof RunStatusSchema>;

/**
 * How a run's turn ended, as DorkOS observed it (spec §4.4). DorkOS never
 * writes an ending it did not observe (ADR 260823-021312).
 *
 * - `completed`, `failed`: the runtime's turn ended on its own.
 * - `stopped`: a stop ended it, proven by a receipt that observed the end or
 *   by the runtime's own `turn_end` reporting an interrupt.
 * - `limited`: a usage limit ended it.
 * - `refused`: the runtime refused before the agent saw it.
 * - `shutdown`: DorkOS ended it while shutting down gracefully.
 * - `process_died`: the process ended with no `turn_end`.
 */
export const RunEndingSchema = z
  .enum(['completed', 'failed', 'stopped', 'limited', 'refused', 'shutdown', 'process_died'])
  .openapi('RunEnding');

/** How a run ended. See {@link RunEndingSchema}. */
export type RunEnding = z.infer<typeof RunEndingSchema>;

/**
 * Why a `queued` run is waiting (spec §3.5, §4.1). Admission's answer; the
 * computer face never gives one.
 */
export const WaitReasonSchema = z
  .enum(['chat_busy', 'agent_busy', 'machine_full', 'paused', 'held_after_restart'])
  .openapi('RunWaitReason');

/** Why a run waits. See {@link WaitReasonSchema}. */
export type WaitReason = z.infer<typeof WaitReasonSchema>;

/**
 * The one line a person sees about a run's ending (spec §7.4), by its case.
 * The app holds the words; the server says which case is true. Each is what
 * recovery decided for a run that ended `process_died` or `shutdown` in a
 * boot that is gone (§7.3), or, before it decided, what the record already
 * proves.
 *
 * - `restart_stopped`: nothing continues it; the runtime cannot pick a turn
 *   back up, or recovery has not decided yet. "DorkOS restarted during this
 *   reply, so it stopped. Send a message to continue."
 * - `restart_continued`: a new turn in the same chat picks it back up.
 *   "DorkOS restarted during this reply. The agent is picking it back up."
 * - `restart_waited_on_you`: it was waiting on the person's answer. "DorkOS
 *   restarted while this waited on you. Send a message to continue."
 * - `restart_chain_cap`: it had already been picked back up three times.
 *   "DorkOS restarted during this reply again. It stopped; send a message to
 *   retry."
 *
 * A restored draft's line ("This message may not have been seen") is the
 * queue row's, not the run's. A client one version behind reads a value it
 * does not know as no line (`parseSessionEvent` in the app), never as an
 * unreadable frame.
 */
export const RunNoticeSchema = z
  .enum(['restart_stopped', 'restart_continued', 'restart_waited_on_you', 'restart_chain_cap'])
  .openapi('RunNotice');

/** A run's line. See {@link RunNoticeSchema}. */
export type RunNotice = z.infer<typeof RunNoticeSchema>;

/** The statuses that make a run its chat's live run: at most one per chat (spec §5). */
export const LIVE_RUN_STATUSES: readonly RunStatus[] = ['starting', 'started', 'running'];

/**
 * One run of a chat, as every device reads it (spec §4.6). Read from the run
 * record, never rebuilt from the stream, so a turn whose process died never
 * reads "working".
 */
export const ChatRunSchema = z
  .object({
    /** The run's id; its reference is `dork:turn:<id>`. */
    id: z.string().min(1),
    /** Its order within the chat, oldest first. */
    chatSeq: z.number().int().positive(),
    status: RunStatusSchema,
    /** Who opened it: a caller, the runtime on its own, or recovery after a restart. */
    openedBy: z.enum(['caller', 'runtime', 'recovery']),
    /** 1 for a new turn; one more for each continuation after a restart. */
    attempt: z.number().int().positive(),
    /** Why a `queued` run waits, when admission said; `null` otherwise. */
    waitReason: WaitReasonSchema.nullable(),
    /** The queue row holding its words while it waits, when it has one. */
    queueMessageId: z.string().nullable(),
    /**
     * Its place among the chat's waiting runs, 1-based, derived at read time:
     * the queue row's order, else the order of its waiting start. `null`
     * unless the run is `queued`.
     */
    queuePosition: z.number().int().positive().nullable(),
    /** Whether the turn is waiting on a person's answer. */
    waitingOnPerson: z.boolean(),
    /** How it ended, as observed; `null` until then. */
    ending: RunEndingSchema.nullable(),
    /** The line a person sees about its ending, or `null` when there is none. */
    notice: RunNoticeSchema.nullable(),
    /** The `seq` of its `turn_start` on the chat's stream, once it started. */
    runtimeTurnRef: z.number().int().nonnegative().nullable(),
    /** What the launch owed a person to know about the chat. */
    warnings: z.array(SessionLaunchWarningSchema),
    /** ISO 8601. */
    createdAt: z.string(),
    /** ISO 8601, once its turn started. */
    startedAt: z.string().nullable(),
    /** ISO 8601, once it ended or was cancelled. */
    endedAt: z.string().nullable(),
  })
  .openapi('ChatRun');

/** One run of a chat. See {@link ChatRunSchema}. */
export type ChatRun = z.infer<typeof ChatRunSchema>;

/**
 * A page of a chat's runs (`GET /api/sessions/{id}/runs`): its live run, its
 * waiting runs and, while nothing is live, the run that ended last, oldest
 * first. The same list `run_update` and the session snapshot carry.
 */
export const ChatRunsPageSchema = z
  .object({
    runs: z.array(ChatRunSchema),
    /** Pass as `cursor` for the next page; `null` when this is the last. */
    nextCursor: z.string().nullable(),
  })
  .openapi('ChatRunsPage');

/** A page of a chat's runs. See {@link ChatRunsPageSchema}. */
export type ChatRunsPage = z.infer<typeof ChatRunsPageSchema>;
