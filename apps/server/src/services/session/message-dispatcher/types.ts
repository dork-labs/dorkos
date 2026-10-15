/**
 * The shapes the message dispatcher works with: the options and results its
 * callers see, and the in-memory records it keeps for open turns, waiting
 * messages and waiting agent compactions.
 *
 * @module services/session/message-dispatcher/types
 */
import type {
  AgentRuntime,
  MessageOpts,
  RuntimeDeliveryResult,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import type { MessageDeliveryOutcome, MessageDisposition } from '@dorkos/shared/schemas';
import type { PermissionModeId, QueuedWaitingOn, SessionSettings } from '@dorkos/shared/types';
import type {
  AdditionalContext,
  ApprovalVerdictData,
  ClientContext,
  RoomContextData,
} from '@dorkos/shared/additional-context';
import type { RuntimeCommandIntentId } from '@dorkos/shared/command-intents';
import type { SessionStateProjector } from '../session-state-projector.js';
import type { TriggerTurnOpts, TriggerTurnResult } from '../trigger-turn.js';
import type { CompactionBoundaryTag } from '../trigger-command-intent.js';

/** The turn a session currently has open, and who owns it. */
export interface InFlightTurn {
  /** The lock identity that started it. */
  clientId: string;
  /** Identity of this particular launch, so a stale settle cannot clear a newer turn. */
  token: symbol;
  /** When the launch claimed the session — what a refusal reports as `since`. */
  startedAt: number;
  /**
   * Whether this launch's turn has appeared on the projector yet.
   *
   * Until it has, the slot is the ONLY evidence about the session, and it says
   * busy: a launch between claiming the slot and its `turn_start` is assembling
   * context, and no `turn_end` can have been seen for a turn that has not
   * started. Once it is true the projector takes over as the authority on
   * whether the turn is still producing — see {@link isStillProducing}.
   */
  sawTurnStart: boolean;
}

/** One accepted message waiting for its turn to come round. */
export interface PendingDispatch {
  /** An optional host lifetime, never document authority. */
  privateDispatchSignal?: AbortSignal;
  /** The server-minted message id; the same id the queue row is keyed by. */
  messageId: string;
  /** The session key it is queued under (canonical where one is known). */
  sessionKey: string;
  /** Who asked for it — the lock identity its turn will run under. */
  clientId: string;
  /**
   * The runtime this message's session resolves to.
   *
   * Carried on the entry, not looked up, because {@link pumpLocked} has to ask
   * it whether a delivery is already on its way ({@link AgentRuntime.isSegmentPending})
   * and this module deliberately knows nothing about the runtime registry —
   * every other runtime it touches was handed to it by its caller.
   */
  runtime: AgentRuntime;
  /** Run it now. Idempotent — the wait bound and the pump can both reach it. */
  launch: (opts: { budgetExhausted: boolean }) => void;
  /** The wait bound's timer, cleared when the dispatch launches. */
  timer: ReturnType<typeof setTimeout>;
  /**
   * True for a message whose launch the write-lock has already refused.
   *
   * The pump skips it until the session reaches a turn boundary, because
   * nothing between now and then can change the lock's answer — and a pump that
   * retried immediately would spin: every refusal hands the slot back, which
   * schedules the pump, which launches it again, which is refused again. That
   * loop exhausted the heap in testing. Only a boundary, a dispatched turn
   * letting go of the lock ({@link rearmLockWaiters}), or the wait bound tries
   * again. A refusal never re-arms anything, so that loop cannot come back.
   */
  waitingOnLock: boolean;
  /**
   * Tell the message's caller it will never run: its `onSettled('failed')`, so
   * whatever it holds until the turn settles (a launch-cap slot, a start
   * reservation, a dispatch buffer entry) is handed back. Called when the
   * message is taken off the queue while it waits.
   */
  abandon: () => void;
  /** A protected document's durable budget wait, independent of lock waiting. */
  notBefore?: number;
  /**
   * Set while this message is held for the agent's background work (DOR-2065):
   * starting it would restart the agent and end that work. The pump does not
   * launch it — nor anything behind it — until a turn boundary or the runtime's
   * gate release clears this, or its own timer does at `releaseAt`.
   */
  held?: QueuedWaitingOn;
}

/** A summary the agent asked for, waiting for its session to come free (DOR-2732). */
export interface PendingAgentCompaction {
  /** The id the agent called from — the runtime's lock may be held under its canonical id. */
  sessionId: string;
  /** The runtime the session resolves to, asked whether a turn is open or the lock held. */
  runtime: AgentRuntime;
  /** Start the compaction. Claims the in-flight slot synchronously. */
  launch: () => Promise<{ accepted: boolean }>;
  /** Asked once, just before it starts: is it still allowed? The owner may have blocked it since. */
  admit?: () => Promise<boolean>;
  /** Called when it is dropped without having run, so its hourly allowance comes back. */
  onDropped?: () => void;
  /** `admit` has said yes. */
  admitted: boolean;
  /** An admission check or a launch is out; the pump must not start a second. */
  launching: boolean;
  /**
   * The write-lock refused the last launch. Retried at the next turn boundary,
   * never sooner, for the reason {@link PendingDispatch.waitingOnLock} gives.
   */
  waitingOnLock: boolean;
  /** Drops it at {@link SESSIONS.AGENT_COMPACTION_MAX_WAIT_MS}. */
  deadline: ReturnType<typeof setTimeout>;
  /**
   * The deadline passed while a check or launch was out. That attempt is left
   * to finish; if it does not end in a running summary, the entry is dropped
   * then, so the ceiling is never skipped.
   */
  expired?: boolean;
  /** A look-again while the runtime reports a turn the server did not dispatch. */
  recheck?: ReturnType<typeof setTimeout>;
}

/**
 * One moment in an accepted message's life, as {@link onDispatchLifecycle}
 * reports it, keyed by the message id the queue row and the turn share.
 *
 * - `started` — a turn began with the message (its `turn_start`).
 * - `settled` — that turn ended, however it ended.
 * - `dropped` — the message left the queue without running and never will:
 *   `removed` when a person took it off (Remove, or Stop clearing the queue),
 *   `session_gone` when the orphan sweep deleted its vanished session's queue.
 *
 * A message whose launch the write-lock refused is NOT dropped: it goes back in
 * line ({@link returnToQueue}). That is why a queued message has no expiry
 * event — see {@link DispatchMessageOpts.queueWaitMs}.
 */
export type DispatchLifecycleEvent =
  | { phase: 'started'; messageId: string; sessionId: string }
  | { phase: 'settled'; messageId: string; sessionId: string; outcome: 'ok' | 'failed' }
  | { phase: 'dropped'; messageId: string; reason: 'removed' | 'session_gone' };

/** Inputs for {@link dispatchMessage}. */
export interface DispatchMessageOpts {
  sessionId: string;
  /** Lock identity of whoever is sending; a message waits only behind its own client. */
  clientId: string;
  /** The person's words, passed through pristine. */
  content: string;
  /**
   * The id this message is accepted under, when the SENDER minted it — the
   * queue row's id, the turn's `messageId`, and the id every
   * {@link DispatchLifecycleEvent} carries. Absent, the dispatcher mints one.
   *
   * For a sender that must hand its own caller a receipt before the message is
   * dispatched at all (`ctx.agent.send` holding a message for capacity), so the
   * id on the receipt and the id on the turn are the same id. Must be unique: it
   * is a primary key.
   */
  messageId?: string;
  /** What the sender asked be done when the session is busy. Defaults to `queue`. */
  disposition?: MessageDisposition;
  cwd?: string;
  /** Neutral client-sourced context signals (ui_state, queued) for this turn. */
  context?: ClientContext;
  /** Where this turn is happening, when a room triggered it. */
  roomContext?: RoomContextData;
  /**
   * The room, the acting member and the turn id, when a room triggered it —
   * routing metadata that never reaches a prompt (spec `room-canvas` §5.3).
   */
  roomTurn?: MessageOpts['roomTurn'];
  /** The home of the agent this turn is dispatched as — see {@link MessageOpts.forAgent}. */
  forAgent?: string;
  /** Background the caller attached to this turn; the person never sees it. */
  seedContext?: string;
  /**
   * How an approval this session asked for ended, when a person answered it after
   * the in-session hold gave up (spec `approval-verdict-delivery`). Passed
   * straight through to the turn, which renders it into the neutral context bag.
   */
  approvalVerdict?: ApprovalVerdictData;
  /**
   * Standing instructions for this turn's system prompt — a room's `ROOM.md`
   * conventions, a scheduled task's brief. Passed straight through to the turn;
   * see {@link TriggerTurnOpts.systemPromptAppend} for what belongs here and
   * what belongs in `content` or `additionalContext`.
   */
  systemPromptAppend?: string;
  /**
   * The folders this turn may reach beyond its cwd (spec `agent-home-desk` §4).
   * Passed straight through to the turn; absent means none, so a queued turn
   * that lost it would silently run with fewer folders than it was given.
   */
  additionalDirectories?: MessageOpts['additionalDirectories'];
  /**
   * Work to do when this turn LAUNCHES, not when it is accepted — immediately
   * for a turn on an idle session, or when a queued turn is released (spec
   * `agent-home-desk` §5.9, §6.1). Its result is merged into the turn before
   * the runtime is called. Passed straight through; see
   * {@link TriggerTurnOpts.prepareLaunch} for where it runs.
   */
  prepareLaunch?: TriggerTurnOpts['prepareLaunch'];
  /**
   * Claude account registry id this LAUNCH should bill to, when the sender made
   * an explicit pre-launch choice. Passed straight through to the turn.
   */
  accountHint?: string;
  /** Per-turn execution settings, when the caller has resolved them itself. */
  settings?: Pick<SessionSettings, 'model' | 'effort'>;
  /**
   * First-turn permission seed for a session with no stored settings. Passed
   * straight through; `TriggerTurnOpts.newSessionPermissionMode` is the
   * authority on the one condition it may be sent under.
   */
  newSessionPermissionMode?: PermissionModeId;
  /**
   * The loosest level this turn may run at. Passed straight through;
   * `MessageOpts.permissionCeiling` is the authority on what it means.
   */
  permissionCeiling?: TurnPermissionCeiling;
  /** The projector for `sessionId` (keyed by the stable client-facing id). */
  projector: SessionStateProjector;
  /** The runtime this session resolves to. */
  runtime: AgentRuntime;
  /** Inactivity window before the stall watchdog fires. */
  stallTimeoutMs?: number;
  /**
   * The whole budget this message may spend waiting for the turns ahead of it,
   * across BOTH the dispatcher's queue and `SessionTurnQueue` underneath.
   * Defaults to `SESSIONS.LOCK_TTL_MS` — the point at which a stranger could
   * take the lock out from under the turn ahead, so an owner is never the last
   * to get in. Whatever is left of it when the message launches is what the
   * chain underneath is given, so the two waits cannot add up past the budget.
   *
   * **For a queueing caller this is not an expiry.** When the budget runs out
   * the message LAUNCHES anyway, meeting the write-lock as a stranger would;
   * a live lock is never replaced (`session-lock.ts`), so behind a turn that is
   * still running that launch is refused and the message goes back in line
   * with a fresh budget ({@link returnToQueue}). A queued message therefore
   * waits for as long as the turn ahead of it runs, however long that is, and
   * leaves the queue only by running or by being removed
   * ({@link DispatchLifecycleEvent} `dropped`). Only a refusing caller's wait
   * ends at its budget.
   */
  queueWaitMs?: number;
  /** Records a detached-turn failure (logging is the caller's concern). */
  onError?(err: unknown): void;
  /** Fired once when the detached turn settles, however it settles. */
  onSettled?(outcome: 'ok' | 'failed'): void;
  /** Receives the `seq` of this turn's `turn_start` — its identity on the stream. */
  onTurnStart?(seq: number): void;
  /** Server-owned receipt for a protected automatic follow-up. */
  privateReceiptId?: string;
  /** Host lifetime for an automatic protected delivery. */
  privateDispatchSignal?: AbortSignal;
  /**
   * Nobody is watching THIS turn. Passed straight through; see
   * {@link TriggerTurnOpts.unattended}.
   */
  unattended?: boolean;
  /**
   * What to do when the session already has a turn open.
   *
   * - `'queue'` (default) — accept it and run it when the session frees up. The
   *   answer for a message a person typed and is watching: it is theirs, it is
   *   durable, every window can see it, and they can edit or remove it while it
   *   waits.
   * - `'refuse'` — answer `{ accepted: false }` and write nothing, while the
   *   agent is still producing. For a trigger a machine generated on somebody's
   *   behalf (an MCP sign-in resume, a UI action), where the reason it was sent
   *   may not survive the wait and firing it late is worse than not firing it.
   *   Once the turn has ENDED there is nothing to fire late into, so the message
   *   is accepted and runs as the stream finishes closing — with no queue row
   *   behind it, and dropped rather than deferred if that stream outlasts the
   *   wait bound ({@link DispatchPlan.transient}).
   * - `'refuse-foreign'` — refuse a turn ANOTHER client opened, and wait behind
   *   one of the caller's own. For a caller that already sequences its own turns
   *   and only needs protecting from a stranger; see {@link WhenBusy}.
   */
  whenBusy?: WhenBusy;
}

/**
 * What a caller wants done when the session is already working.
 *
 * **"Already working" means the agent is still PRODUCING**, not that the last
 * turn's stream has finished closing. Both refusing modes ask
 * {@link isStillProducing} first, so neither of them refuses over a turn that has
 * already ended — see that function for the window this cost the product
 * (DOR-1239).
 *
 * **`'refuse-foreign'` is the same promise as `'refuse'`, asked of the right
 * question.** A refusing caller is saying "do not queue my trigger behind
 * somebody else's work" — and a turn the CALLER ITSELF opened is not somebody
 * else's work. Rooms are why the distinction exists: a room already allows one
 * turn per `(room, agent)` and holds a re-mention until that turn's claim
 * releases (RP8, `room-collect.ts`), so by the time the held message is
 * dispatched the previous turn has ended on the projector — but the in-flight
 * slot it took is cleared a beat later, when the turn settles. A blanket
 * `'refuse'` lost that race and told the room its own agent was busy with
 * something else, so the room wrote "didn't pick this up, send it again" over a
 * message it was about to answer (DOR-1230).
 *
 * A foreign turn is still refused, which is the case the notice was written for:
 * somebody typing into the very agent a room addressed.
 *
 * @see DispatchMessageOpts.whenBusy
 */
export type WhenBusy = 'queue' | 'refuse' | 'refuse-foreign';

/** What happened to a message the dispatcher accepted. */
export interface MessageDispatchResult extends TriggerTurnResult {
  /** What was asked for, what was applied, and why they differ. */
  outcome: MessageDeliveryOutcome;
  /**
   * Where the message sat in its session's queue at acceptance, 1-based.
   * `1` means it was the head — nothing was ahead of it. `0` means it is on no
   * queue at all: a refusal, a steer/stage that landed natively through the
   * degradation ladder, or any refusing caller that WAITS — a `'refuse-foreign'`
   * behind its own turn, or a {@link DispatchPlan.transient} behind a closing
   * stream. Those are accepted (`queued: true`) and deliberately rowless, so
   * there is no position to report. See the module doc.
   */
  queuePosition: number;
  /**
   * True when the message is waiting rather than running. Its turn begins when
   * the session frees up, announced on the session's stream like every other
   * queue change — for the queueing callers that have a row. A refusing caller
   * waits in memory only and announces nothing, because a person was never shown
   * it in the first place.
   */
  queued: boolean;
  /**
   * Who holds the turn this message was refused for, when the dispatcher could
   * name them. Present only on a refusal, and absent when the holder let go in
   * the same beat it said no.
   *
   * It exists so a caller answering `409 SESSION_LOCKED` can name a holder that
   * really exists. A route asking its own authority instead — `getLockInfo`,
   * under the id the REQUEST used rather than the canonical one the lock is
   * keyed by — could not see the turn the dispatcher had just refused it for, so
   * it reported `lockedBy: "unknown"`: a locked session with nobody holding it
   * (DOR-1239).
   */
  refusedBy?: {
    /** The lock identity of the turn that caused the refusal. */
    clientId: string;
    /** Epoch ms at which that turn claimed the session. */
    since: number;
  };
}

/** Everything one accepted message needs to become a running turn. */
export interface DispatchPlan {
  /** The client-facing session id the turn is triggered under. */
  sessionId: string;
  /** The id this session's in-memory dispatcher state is filed under. */
  sessionKey: string;
  clientId: string;
  content: string;
  /** The server-minted id shared by the queue row, the turn, and the outcome. */
  messageId: string;
  projector: SessionStateProjector;
  runtime: AgentRuntime;
  /** The whole budget this message may spend waiting for the turns ahead of it. */
  budgetMs: number;
  /** When it started spending that budget. */
  startedWaitingAt: number;
  /**
   * What a launch that started no turn means for this message: go back in line
   * (`'queue'`, the default everywhere except the callers that opt out) or be
   * given up on (either refusing mode) — unless {@link DispatchPlan.answered},
   * which outranks it.
   */
  whenBusy: WhenBusy;
  /**
   * Somebody has already been told this message was accepted.
   *
   * True wherever that is so: a `'refuse-foreign'` plan that waited out the
   * caller's own turn, and every row {@link adoptQueuedMessages} recovered,
   * whose original caller was answered by a process that is now gone.
   *
   * It only CHANGES anything for a refusing plan, and there it outranks
   * `whenBusy`. Giving up is the promise `'refuse'` makes about words nobody
   * has been promised anything about; once an `accepted: true` is out there it
   * cannot be taken back, so the message goes back in line like anybody else's
   * rather than evaporating (the DOR-480 rule, in the module doc above).
   *
   * It buys a bounded second chance, not an unlimited one: what it may still
   * spend is whatever is left of {@link DispatchPlan.budgetMs} measured from the
   * unmoved {@link DispatchPlan.startedWaitingAt}, and when that runs out the
   * plan is dropped once and reported. {@link returnToQueue} is where both
   * halves live.
   */
  answered: boolean;
  /**
   * This message is DROPPED rather than deferred the moment it cannot run —
   * fast, or never.
   *
   * True for exactly one shape: a blanket-`'refuse'` caller accepted while the
   * session's slot is still held by a turn that has ALREADY ENDED (the drain
   * window, DOR-1239). It is waiting out a stream that is closing, not queueing
   * behind work, so there is no later moment worth running at.
   *
   * **This is a DISPOSAL flag, and only that.** It used to carry rowlessness
   * too, which is no longer its to carry: no refusing caller gets a row at all
   * now, whichever mode it asked for (DOR-1242, module doc above). What is left
   * here is the narrower claim — that this particular wait must not be re-parked
   * and must not be forced through:
   *
   * - {@link returnToQueue} must not re-park it. It is `answered: true` by
   *   construction, so the bounded second chance a `'refuse-foreign'` gets would
   *   otherwise apply to it, and this one has nothing to come back for.
   * - The budget bound must not FORCE it through. A budget-exhausted launch
   *   deliberately skips the in-flight slot, which for a stream that is still
   *   open means a second `sendMessage` racing the first on one session.
   *
   * **`'refuse-foreign'` is deliberately NOT this**, though it can wait in the
   * same window. What the two carry is different: a `'refuse'` trigger is
   * machine-generated (a widget click, a sign-in nudge) and belongs to nobody,
   * while a `'refuse-foreign'` message is a person's words in a room, which
   * DOR-1230 accepts precisely so the room answers them. Those keep their PLACE
   * IN LINE — bounded by what is left of their original wait — rather than being
   * dropped at the first refusal.
   *
   * It sorts behind anything with a row ({@link orderedWaiting}), which is
   * anything a person typed — the right way round, since those words came first.
   */
  transient: boolean;
  /** What the caller passes straight through to the turn. */
  turn: Pick<
    DispatchMessageOpts,
    | 'cwd'
    | 'context'
    | 'roomContext'
    | 'roomTurn'
    | 'forAgent'
    | 'seedContext'
    | 'approvalVerdict'
    | 'systemPromptAppend'
    | 'additionalDirectories'
    | 'prepareLaunch'
    | 'accountHint'
    | 'settings'
    | 'newSessionPermissionMode'
    | 'permissionCeiling'
    | 'stallTimeoutMs'
    | 'onError'
    | 'onSettled'
    | 'onTurnStart'
    | 'privateReceiptId'
    | 'privateDispatchSignal'
    | 'unattended'
  >;
}

/** Inputs for {@link dispatchCommandIntent}. */
export interface DispatchCommandIntentOpts {
  sessionId: string;
  clientId: string;
  /** The runtime-fulfilled intent to dispatch (e.g. `'compact'`). */
  intent: RuntimeCommandIntentId;
  cwd?: string;
  /** Trailing instructions after the intent token. */
  instructions?: string;
  projector: SessionStateProjector;
  runtime: AgentRuntime;
  stallTimeoutMs?: number;
  /**
   * Total waiting budget. Defaults to {@link COMMAND_INTENT_QUEUE_WAIT_MS},
   * deliberately SHORTER than a turn's: the client abandons the request at
   * `COMMAND_INTENT_REQUEST_TIMEOUT_MS`, and a server that waited longer would
   * show the person a failure and compact the conversation afterwards anyway
   * (DOR-1101). Both bounds derive from the one constant, so they cannot drift.
   */
  queueWaitMs?: number;
  /**
   * Fields stamped on the run's `compact_boundary` — set only for a summary the
   * agent asked for (DOR-2732), so the chat can say so.
   */
  boundaryTag?: CompactionBoundaryTag;
  onError?(err: unknown): void;
}

/** Inputs for {@link deliverSteer}. */
export interface DeliverSteerOpts {
  /** The session to steer; either id a caller might hold. */
  sessionId: string;
  /** The client asking to steer — the identity the authorization gate turns on. */
  clientId: string;
  /** The person's words, passed through pristine. */
  content: string;
  /** The server-minted correlation id for this steered message. */
  messageId: string;
  /** The neutral context bag, assembled server-side; rendered out of band. */
  additionalContext?: AdditionalContext;
  /** The runtime this session resolves to. */
  runtime: AgentRuntime;
}

/**
 * What a steer did, plus whether the caller was allowed to make it.
 *
 * `authorized: false` is distinct from an ordinary `delivered: false`: the
 * steer was refused before the runtime was ever asked, because the caller does
 * not own the turn. The degradation ladder (task 4.4) turns an unauthorized or
 * undelivered steer into a queued message; this is the receipt it reads.
 */
export interface SteerDeliveryResult extends RuntimeDeliveryResult {
  /** True when the caller was entitled to steer this session's live turn. */
  authorized: boolean;
}

/** Inputs for {@link deliverStage}. */
export interface DeliverStageOpts {
  /** The session to stage onto; either id a caller might hold. */
  sessionId: string;
  /** The client staging — the identity the authorization gate turns on. */
  clientId: string;
  /** The person's words, passed through pristine. */
  content: string;
  /** The server-minted correlation id for this staged message. */
  messageId: string;
  /** The neutral context bag, assembled server-side; rendered out of band. */
  additionalContext?: AdditionalContext;
  /** The runtime this session resolves to. */
  runtime: AgentRuntime;
}

/**
 * What a stage did, plus whether the caller was allowed to make it.
 *
 * `authorized: false` is distinct from an ordinary `delivered: false`, exactly as
 * it is for a steer: the stage was refused before the runtime was ever asked,
 * because a DIFFERENT client owns the live turn.
 */
export interface StageDeliveryResult extends RuntimeDeliveryResult {
  /** True when the caller was entitled to write to this session. */
  authorized: boolean;
  /**
   * Why the stage landed via the fold-into-next FALLBACK rather than the
   * runtime's native transcript — the text is held and rides the next dispatch.
   * Absent on the native path. The person cannot tell the two apart, and should
   * not have to; this is for callers that log or degrade.
   *
   * `not-stageable` means the seam went away under this session between the
   * router's gate and the delivery — an idle reap of a warm process is the way
   * that happens (DOR-1325), and it is the fold the design intends.
   * `unsupported` means the runtime could not stage at all where nothing said it
   * had stopped being able to, which IS an adapter bug and is logged as one.
   */
  foldedBecause?: 'unsupported' | 'not-stageable';
}
