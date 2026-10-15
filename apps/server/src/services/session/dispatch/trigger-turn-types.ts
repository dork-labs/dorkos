import type {
  MessageOpts,
  SseResponse,
  RuntimeCapabilities,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import type {
  InterruptReceipt,
  PermissionModeId,
  QueuedWaitingOn,
  SessionSettings,
  StreamEvent,
} from '@dorkos/shared/types';
import type {
  ApprovalVerdictData,
  ClientContext,
  RoomContextData,
} from '@dorkos/shared/additional-context';
import type { SessionStateProjector } from '../session-state-projector.js';
import type {
  PrivateSessionMessageClaimResult,
  PreparedPrivateSessionMessage,
} from '../private-messages/acceptance.js';

/** The collaborators {@link triggerTurn} needs, narrowed to a runtime-neutral port. */
export interface TriggerTurnDeps {
  /** Move only the original native acquisition; absence never issues F2 ancestry. */
  moveNativeLock?(oldId: string, newId: string, holder: SseResponse): boolean | undefined;
  /**
   * Acquire the session write-lock; returns false when held by another client.
   * The `token` is the per-turn lock identity (I1) so {@link releaseLock} can be
   * token-matched and a superseded same-client turn cannot drop a newer lock.
   */
  acquireLock(sessionId: string, clientId: string, res: SseResponse, token?: symbol): boolean;
  /**
   * Release the session write-lock for this client (idempotent at the manager).
   * When `token` is supplied, release is a no-op unless it matches the current
   * lock's token — a stale releaser from a superseded turn does nothing (I1).
   */
  releaseLock(sessionId: string, clientId: string, token?: symbol): void;
  /** The runtime's per-turn event generator. */
  sendMessage(
    sessionId: string,
    content: string,
    opts: MessageOpts,
    holder: SseResponse,
    lockKey: string
  ): AsyncGenerator<StreamEvent>;
  /**
   * End a turn the runtime has left open before this one starts, answering
   * whether it settled anything (`AgentRuntime.settleOpenTurn`). Absent for a
   * runtime that cannot strand a turn — which reads as "nothing to settle".
   */
  settleOpenTurn?(sessionId: string): Promise<boolean>;
  /**
   * Interrupt the runtime's in-flight turn (stall watchdog). Answers the
   * {@link InterruptReceipt} vocabulary — `not-running` when there was none.
   */
  interruptQuery(sessionId: string): Promise<InterruptReceipt>;
  /**
   * Whether a helper the agent launched is still working in this session
   * (`AgentRuntime.isHelperWorking`). Absent for a runtime with no helpers,
   * which reads as "no".
   */
  isHelperWorking?(sessionId: string): boolean;
  /**
   * The runtime answers {@link MessageOpts.dispatchHold} on every send
   * (`AgentRuntime.switchWhenReady` is its marker). Absent reads as "no": the
   * turn starts without asking.
   */
  answersDispatchHold?: boolean;
  /** Resolve the backend-internal (canonical) id once the adapter assigns it. */
  getInternalSessionId(sessionId: string): string | undefined;
  /**
   * Re-key the projector registry entry from `oldId` to `newId`, preserving the
   * SAME projector instance (C1). Called once the canonical id is resolved for a
   * brand-new session so a later `/events` subscription keyed by the canonical id
   * resolves to the in-flight turn's projector, not a fresh empty one. A no-op
   * when the id is unchanged. Runtime-neutral: the registry is id-keyed, not
   * runtime-specific.
   */
  rekeyProjector(oldId: string, newId: string): void;
  /**
   * Capabilities of the active runtime — the assembler reads `nativeContext`
   * to omit any context kind the runtime injects itself.
   */
  getCapabilities(): RuntimeCapabilities;
  /** Resolve minimized protected content before the final synchronous preflight. */
  preparePrivateMessage?(receiptId: string): Promise<PreparedPrivateSessionMessage>;
  /** Revalidate and exclusively claim immediately before the runtime call. */
  claimPrivateMessage?(
    receiptId: string,
    prepared: PreparedPrivateSessionMessage,
    sessionId?: string
  ): PrivateSessionMessageClaimResult;
  /** Cancel an accepted receipt when final authority fails before any runtime effect. */
  cancelPrivateMessage?(receiptId: string, reason: string): void;
  /** Classify a proven authority denial without treating storage/unavailability as revocation. */
  isPrivatePreclaimRefusal?(receiptId: string, error: unknown): boolean;
  /** Quarantine a claim if no turn start can be observed. */
  markPrivateOutcomeUnknown?(receiptId: string, reason: string): void;
}

/** Inputs for {@link triggerTurn}. */
export interface TriggerTurnOpts {
  /** Private dispatcher plan identity; a caller bag or persisted row cannot reproduce it. */
  originalRoomPlan?: object;

  sessionId: string;
  clientId: string;
  content: string;
  cwd?: string;
  /** Neutral client-sourced context signals (ui_state, queued) for this turn. */
  context?: ClientContext;
  /**
   * Where this turn is happening, when a room triggered it. Passed straight to
   * the assembler; it is server-derived and never reaches this from a client.
   */
  roomContext?: RoomContextData;
  /**
   * Where this turn is happening, when a ROOM triggered it — routing metadata,
   * never prompt context (spec `room-canvas` §5.3).
   *
   * Deliberately NOT folded into `additionalContext` below: it carries an opaque
   * dispatch id and a member id, and neither belongs in front of a model. It is
   * handed to the runtime beside the bag instead, which is what lets a
   * `control_ui` taken inside a room turn land on the room's shared canvas.
   */
  roomTurn?: MessageOpts['roomTurn'];
  /**
   * The home of the agent this turn is dispatched as, when a server path names
   * one — handed to the runtime beside `roomTurn` ({@link MessageOpts.forAgent}).
   */
  forAgent?: string;
  /**
   * Background the caller attached to this turn — the agent reads it, the person
   * never sees it. Passed straight to the assembler, which renders it into the
   * neutral bag as a `seed_context` entry; `content` is untouched.
   */
  seedContext?: string;
  /**
   * How an approval this session asked for ended, when a person answered it late
   * (spec `approval-verdict-delivery`). Passed straight to the assembler, which
   * renders it into the neutral bag as an `approval_verdict` entry.
   *
   * Server-composed from the approval row and reachable only from
   * `core/approvals/approval-verdict-delivery.ts` — never from a wire payload.
   */
  approvalVerdict?: ApprovalVerdictData;
  /**
   * Instructions the CALLER attaches to this turn's system prompt, ahead of
   * anything the person typed and behind everything DorkOS says about the agent
   * itself (`launch-resolver.ts` concatenates it after the base append).
   *
   * The channel for standing framing that must sit in the cacheable prefix
   * rather than in the turn's own words: a scheduled task's brief, a room's
   * `ROOM.md` conventions. Not for anything a person typed — that is `content`,
   * and not for per-turn signals — those are `additionalContext` (ADR-0273).
   *
   * Passed straight to the runtime, which decides how to deliver it: claude-code
   * puts it on the SDK's `systemPrompt.append` and relaunches a warm process
   * when it changes, while codex and opencode have no system-prompt channel and
   * compose it into each turn's input. All three deliver a CHANGED value on the
   * next turn of a running session, which the shared runtime conformance suite
   * pins (`project-rooms` §3.3).
   */
  systemPromptAppend?: string;
  /**
   * The folders this turn may reach beyond its cwd, computed by the caller for
   * THIS turn (spec `agent-home-desk` §4). Passed straight to the runtime, which
   * hands exactly this set to its backend; absent means none.
   */
  additionalDirectories?: MessageOpts['additionalDirectories'];
  /**
   * Work that must happen at the moment this turn LAUNCHES — after its write
   * lock is held and any turn still open on the session has settled, before
   * the room context is rendered and the runtime is called (spec
   * `agent-home-desk` §5.9, §6.1). What it returns is merged into the turn.
   *
   * Launch, not acceptance: a turn can wait in the queue behind another turn
   * on the same session, and work done while it waited would happen under that
   * running turn. A rejection is logged and the turn runs as it was accepted —
   * nothing here may cost a person their answer.
   */
  prepareLaunch?: () => Promise<Partial<Pick<TriggerTurnOpts, 'roomContext'>>>;
  /**
   * Which billing account this LAUNCH should run on, as a Claude account
   * registry id. Set only by the route that accepted a person's pre-launch
   * choice on the send that creates a claude-code session; passed straight
   * through to the runtime, which resolves it against the registry and stores
   * nothing (ADR 260821-205323).
   */
  accountHint?: string;
  /**
   * Execution settings for THIS turn, when the caller has resolved them itself.
   *
   * The normal path leaves this unset: settings live in `session_metadata` and
   * every adapter reads them there. Rooms are the exception — a room session's
   * row is written AFTER the turn is known to have started (so a runtime that
   * throws leaves no orphan row), which is too late to seed the turn that is
   * starting. The runner therefore resolves the same defaults and passes them
   * here for the session's FIRST turn; once the row exists it passes an empty
   * object instead, so from the second turn nothing is overridden and the row
   * governs.
   *
   * Deliberately narrower than `SessionSettings`: model and effort are the two
   * a caller may resolve for one turn. `permissionMode` and `fastMode` are
   * posture, not preference, and must not be smuggled in as a per-send override
   * that outranks what the person set on the session. A first-turn permission
   * seed has its own field, {@link TriggerTurnOpts.newSessionPermissionMode},
   * precisely so it cannot arrive disguised as a preference.
   */
  settings?: Pick<SessionSettings, 'model' | 'effort'>;
  /**
   * The permission mode a session with NO stored settings should start its very
   * first turn at (DOR-1917).
   *
   * **A seed, never an override, and the name is the whole guarantee.** It is
   * separate from {@link TriggerTurnOpts.settings} because the condition it
   * rides under cannot be expressed in that field: a room's `session_metadata`
   * row is written after its turn starts, so the first turn cannot inherit a
   * posture the ordinary way, while every later turn must. A caller sends this
   * only for a session it has established has no stored settings — and since
   * there is nothing stored, there is nothing to outrank. Every runtime resolves
   * a turn as `per-send → persisted → its own default`, so on any other session
   * this would silently beat a person's choice.
   *
   * The room turn runner is the only caller, and it sends the operator's own
   * configured power level, resolved through `resolveUnattendedPermissionMode`
   * against the runtime the turn landed on and clamped to entries written on
   * this machine. The session route never sends one: by the time it dispatches,
   * the row exists and governs.
   */
  newSessionPermissionMode?: PermissionModeId;
  /**
   * The loosest level THIS turn may run at, handed to the runtime as
   * `MessageOpts.permissionCeiling` (spec `trusted-by-default-flip` §4). Unlike
   * {@link TriggerTurnOpts.newSessionPermissionMode} it may ride on any
   * session, because it can only make a turn stricter, and it is never stored.
   */
  permissionCeiling?: TurnPermissionCeiling;
  /**
   * The dispatcher's id for this message, handed to the runtime so a `result`
   * can be correlated back to the message that caused it.
   *
   * Correlation is by id and NEVER positional: a runtime that coalesces a
   * dequeued batch answers several dispatched ids with ONE result, so counting
   * results against sends silently mismatches. Absent for a caller that has not
   * been through the dispatcher (there is none in production).
   */
  messageId?: string;
  /** Server-owned receipt for a protected automatic follow-up. */
  privateReceiptId?: string;
  /** Host shutdown suspends protected work before claim, preserving its durable receipt. */
  privateDispatchSignal?: AbortSignal;
  /**
   * Nobody is watching THIS turn (an automatic carry-over to another
   * account): an approval card does not hold it (spec `agent-permissions` D6)
   * and an ask raised in it is refused at once. Sent as the runtime's
   * per-turn `unattendedApprovals` and `unattended`, so a person's next turn
   * in the same session asks and holds as usual.
   */
  unattended?: boolean;
  /** The projector for `sessionId` (keyed by the client-facing id, which is stable). */
  projector: SessionStateProjector;
  deps: TriggerTurnDeps;
  /** Inactivity window before the stall watchdog fires. Defaults to SESSIONS.TURN_STALL_TIMEOUT_MS. */
  stallTimeoutMs?: number;
  /**
   * How long this trigger may wait for the same client's earlier turns on this
   * session before proceeding anyway. Defaults to SESSIONS.LOCK_TTL_MS, so a
   * queued turn is never made to wait longer than the point at which a STRANGER
   * could take the lock out from under the turn ahead of it (review G1c).
   */
  queueWaitMs?: number;
  /** Records a detached-turn failure (logging is the caller's concern). */
  onError?(err: unknown): void;
  /**
   * Fired once when the DETACHED turn settles, however it settles.
   *
   * The 202 resolves long before this. A caller that wants to record how a turn
   * ended — the diagnostic dispatch buffer does — has nowhere else to learn it,
   * because the request is gone and `onError` only fires on a failure.
   *
   * A throw here is caught and logged rather than allowed to escape: this runs
   * on the turn's own settlement path, where an unhandled rejection would take
   * down work that has already succeeded. An observability hook must be
   * structurally unable to kill a turn.
   *
   * @param outcome - `'failed'` when the turn reported an error, else `'ok'`.
   */
  onSettled?(outcome: 'ok' | 'failed'): void;
  /**
   * Receives the `seq` of THIS turn's `turn_start` — its identity on the durable
   * stream.
   *
   * For the one caller that both triggers a turn and reads the same stream back:
   * a room. Without it the room had to guess which `turn_start` was its own by
   * comparing the trigger text, which any other turn carrying the same words
   * satisfies — and which a turn carrying NO text (a `/compact`-style command
   * intent, whose `turn_start` has no `userMessage` at all) satisfied by
   * default. A seq is the identity itself, so neither is a question any more.
   *
   * Fired synchronously, before the turn's first event can reach any subscriber
   * — see `feedProjector`.
   *
   * @param seq - The `turn_start`'s seq.
   */
  onTurnStart?(seq: number): void;
}

/** Outcome of a {@link triggerTurn} attempt. */
export interface TriggerTurnResult {
  /** True when the lock was acquired and the turn started. */
  accepted: boolean;
  /** The canonical session id to return in the 202 body (when accepted). */
  canonicalId?: string;
  /** The host stopped before protected claim; leave durable work for another boot. */
  suspended?: true;
  /** A durable protected-source budget wait; no runtime effect has been claimed. */
  deferred?: { reason: string; nextEligibleAt: string };
  /**
   * Starting the turn would have ended the agent's background work, so no turn
   * was started and the lock is free again (DOR-2065). The message stays
   * queued, showing this.
   */
  held?: QueuedWaitingOn;
}
