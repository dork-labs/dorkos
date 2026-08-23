/**
 * In-memory session store — lifecycle, lookup, and interactive flow management.
 *
 * Extracted from ClaudeCodeRuntime to keep the runtime class as a thin facade.
 * Owns the session Map, SDK session index, and all session mutation logic.
 *
 * @module services/runtimes/claude-code/session-store
 */
import { forkSession as sdkForkSession, type Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  PermissionMode,
  EffortLevel,
  Session,
  PendingInteractionDTO,
} from '@dorkos/shared/types';
import type {
  SessionOpts,
  MessageOpts,
  SessionSettingsPort,
  ToolDecisionOptions,
} from '@dorkos/shared/agent-runtime';
import type { AgentSession } from '../agent-types.js';
import { SESSIONS } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';
import { resolveActiveClaudeRoot } from '../claude-config-dir.js';
import { withClaudeConfigDir } from '../claude-config-env-lock.js';
import type { TranscriptReader } from './transcript-reader.js';
import type { SessionLockManager } from '../../../session/session-lock.js';
import {
  awaitControlAck,
  PERMISSION_MODE_ACK_TIMEOUT_MS,
  STOP_ACK_SLOW_MS,
  STOP_ACK_TIMEOUT_MS,
  type ControlAck,
} from './bounded-control.js';

/**
 * Is this session holding a prompt somebody could still come back and answer?
 *
 * The one bounded answer for the whole runtime: record eviction here, and the
 * dispatch refusal and warm reap in `persistent-dispatch.ts`, which used the
 * pending map's raw size and so would have refused messages into a session with
 * a STRANDED entry forever.
 *
 * The exemption's bound is the wait THIS session actually allows, measured from
 * when the prompt was raised: the park ceiling for a session a person may come
 * back to, and the plain countdown for an unattended run, whose prompts never
 * park (spec `ask-parks-on-timeout` §7, §8). So a stranded entry ages out on
 * exactly the clock its own runtime would have refused it on, and a scheduled
 * run gets no four-hour reprieve it could never have used.
 *
 * @param session - The session to weigh.
 * @param now - Server epoch ms.
 */
export function isWaitingOnPerson(session: AgentSession, now: number): boolean {
  const ceilingMs =
    session.unattended === true
      ? SESSIONS.INTERACTION_TIMEOUT_MS
      : SESSIONS.INTERACTION_PARK_CEILING_MS;
  for (const pending of session.pendingInteractions.values()) {
    if (now - pending.startedAt < ceilingMs) return true;
  }
  return false;
}

/**
 * Manages in-memory session state for the Claude Code runtime.
 *
 * Tracks active sessions, handles the SDK session ID reverse index,
 * and provides session lifecycle, interactive flow, and health check operations.
 */
export class SessionStore {
  private sessions = new Map<string, AgentSession>();
  /** Reverse index: SDK session ID → session map key, for O(1) lookup. */
  private sdkSessionIndex = new Map<string, string>();
  private readonly SESSION_TIMEOUT_MS = SESSIONS.TIMEOUT_MS;

  /** Core settings store (ADR-0260) — durable hydrate/write-through. Injected once at boot. */
  private settingsPort?: SessionSettingsPort;
  /** Runtime's default permission mode, used when neither opts nor the store supply one. */
  private defaultPermissionMode: PermissionMode = 'default';

  /**
   * Inject the core session-settings store and the runtime's default fallback
   * mode. Called once at the composition root via the runtime's
   * `setSessionSettings`.
   *
   * @param port - Core settings store implementing {@link SessionSettingsPort}
   * @param defaultMode - Mode to seed when no override or persisted value exists
   */
  configureSettings(port: SessionSettingsPort, defaultMode: PermissionMode): void {
    this.settingsPort = port;
    this.defaultPermissionMode = defaultMode;
  }

  /**
   * Adopt a new canonical SDK session id for a live session, called by the
   * message sender the moment the SDK assigns one (the first turn of a brand-new
   * session, or a resume that starts a fresh transcript).
   *
   * Two things move together, which is the whole point of doing it here: the
   * reverse index, so lookups by either id still land on this session, AND the
   * durable settings row, so the id every future read asks by is the id the
   * operator's chosen permission mode is stored under. Leaving the row on the
   * old id would silently revert the ENFORCED mode to the runtime default on the
   * first turn after an eviction or a restart (DOR-493).
   *
   * The id the turn was ASKED with is only a hint here, never the answer: the
   * SDK can rename the same conversation more than once, and from the second
   * rename on, the caller is asking by an id that is an index alias rather than
   * the key the session is stored under. Writing that alias into the index as
   * if it were the map key stranded the session — neither current id resolved,
   * and the next resume looked for a transcript the SDK had already renamed
   * away from (DOR-774). So the map key is resolved, from the asked id or the
   * outgoing one, whichever the store still recognises.
   *
   * Every id the session has ever answered to keeps pointing at it. Clients
   * legitimately hold different links in that chain — the cockpit adopts the id
   * the 202 reports, a room holds the id it bound — and a turn already in
   * flight is being tracked by the id it started under. Eviction sweeps the
   * whole chain, so nothing outlives the session.
   *
   * **WHEN this is called is load-bearing; the order of the two writes inside it
   * is not.** The caller (`message-sender`) invokes this BEFORE yielding the
   * event that lets `trigger-turn` announce the canonical id to the cockpit. A
   * client can only send a message under an id it has been told, so moving the
   * row first is what stops the session's own next POST from looking like a
   * brand-new session to `persistSessionRuntime` — which would mint a second
   * row, pre-seeded with the server's default trust stop, and leave the re-key
   * merging the operator's choice against a default nobody picked (DOR-838).
   * Do not move this call back after the yield.
   *
   * The two writes below may run in either order — that was measured, not
   * assumed: swapping them reddens nothing, because everything that could
   * observe the gap between them is downstream of the announcement this call
   * precedes. The row is written first only because the index write cannot fail.
   *
   * A failure to move the row can neither fail the turn nor hold back the index.
   * This runs mid-stream: before DOR-493 the rebind was Map writes that could
   * not throw, and a settings store that is briefly unavailable must not become
   * a lost turn on a step that never used to have a failure mode. Publishing the
   * alias anyway is deliberate — `sdkSessionId` has ALREADY changed by the time
   * this is called, so the index is only catching up to a fact, and withholding
   * it would leave approvals, interrupt, and the event stream unable to resolve
   * the canonical id for the rest of the session. A store failure therefore
   * lands exactly where the pre-DOR-493 code always did — row under the old id,
   * turn unaffected — plus a warning.
   *
   * @param previousSdkSessionId - The canonical id held until now
   * @param nextSdkSessionId - The canonical id the SDK just assigned
   * @param requestedSessionId - The id the turn was asked with, as a lookup hint
   */
  async rebindSdkSession(
    previousSdkSessionId: string,
    nextSdkSessionId: string,
    requestedSessionId: string
  ): Promise<void> {
    if (previousSdkSessionId === nextSdkSessionId) return;
    // Resolved before the await: the maps can be swept while it is pending, and
    // the key this rebind is about is the one that existed when it started. This
    // is also why the row moves first — not an ordering guarantee (see the doc
    // above), just the write that can throw going before the one that cannot.
    const sessionMapKey =
      this.resolveMapKey(requestedSessionId) ?? this.resolveMapKey(previousSdkSessionId);
    try {
      await this.settingsPort?.rekeySessionSettings(previousSdkSessionId, nextSdkSessionId);
    } catch (err) {
      logger.warn('[rebindSdkSession] settings re-key failed; row stays under the previous id', {
        previousSdkSessionId,
        nextSdkSessionId,
        err: err instanceof Error ? err.message : String(err),
      });
    }
    if (sessionMapKey) {
      this.sdkSessionIndex.set(previousSdkSessionId, sessionMapKey);
      this.sdkSessionIndex.set(nextSdkSessionId, sessionMapKey);
    } else {
      // The session was evicted mid-turn. Nothing to index — but the settings
      // row still had to follow the id above, or the operator's mode reverts on
      // the next cold resume.
      logger.warn('[rebindSdkSession] no live session for rebind; indexed nothing', {
        requestedSessionId,
        previousSdkSessionId,
        nextSdkSessionId,
      });
    }
  }

  /** The key a session is stored under, given any id it answers to. */
  private resolveMapKey(sessionId: string): string | undefined {
    if (this.sessions.has(sessionId)) return sessionId;
    const mappedKey = this.sdkSessionIndex.get(sessionId);
    return mappedKey !== undefined && this.sessions.has(mappedKey) ? mappedKey : undefined;
  }

  /**
   * The single answer to "which key is this session's warm process filed
   * under?" — {@link resolveMapKey} with a total return, so a caller never has
   * to decide what an unresolved id means.
   *
   * `PersistentDispatch` and `SessionPumpRegistry` (`sessions/persistent-dispatch.ts`,
   * `sessions/session-pump-registry.ts`) key their own maps by this rather than
   * by whatever id a caller happens to pass, which is what makes a pump
   * reachable by every id its session has ever answered to — the request UUID
   * a first turn warmed it under AND the canonical id the SDK re-mints on that
   * same turn's `system/init` (ADR-0267). Before this existed, those two maps
   * were keyed by the raw id: turn 1 warmed a process under the request UUID,
   * the rebind updated only THIS store's own reverse index, and turn 2's POST
   * — sent under the canonical id the 202 just taught the client — missed both
   * maps and started a second warm process beside the first, which then sat
   * orphaned until the idle reaper (DOR-1309).
   *
   * Falls back to `sessionId` itself for an id this store has never heard of —
   * a genuinely new session has no alias to resolve TO yet, and is about to
   * become the map key on its own first use, so the id already is its own
   * answer.
   *
   * @param sessionId - Any id the session answers to, or an id nobody has used
   */
  sessionKeyOf(sessionId: string): string {
    return this.resolveMapKey(sessionId) ?? sessionId;
  }

  /** Find a session by map key or SDK session ID (O(1) via reverse index). */
  findSession(sessionId: string): AgentSession | undefined {
    const direct = this.sessions.get(sessionId);
    if (direct) return direct;
    const mappedKey = this.sdkSessionIndex.get(sessionId);
    return mappedKey ? this.sessions.get(mappedKey) : undefined;
  }

  /**
   * Enumerate sessions that hold a reloadable SDK query — one whose subprocess
   * is still alive enough to answer the `reload_plugins` control request. A
   * live `activeQuery` (mid-turn) is preferred; a preserved `lastQuery` (the
   * subprocess kept alive past the previous turn) is the fallback. Sessions
   * that have never run a query expose neither and are skipped.
   *
   * Used by the runtime to push a fresh command list into every live session
   * after a marketplace install, since the SDK only surfaces newly-installed
   * plugin commands via a `reload_plugins` round-trip on an existing query — a
   * cold re-fetch returns the stale init-time list (SDK `commands_changed` doc).
   */
  getReloadableSessions(): Array<{ sessionId: string; session: AgentSession }> {
    const reloadable: Array<{ sessionId: string; session: AgentSession }> = [];
    for (const [sessionId, session] of this.sessions) {
      if (session.activeQuery ?? session.lastQuery) {
        reloadable.push({ sessionId, session });
      }
    }
    return reloadable;
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Start or resume an agent session.
   *
   * For new sessions, sdkSessionId is assigned after the first query() init message.
   * For resumed sessions, the sessionId IS the sdkSessionId.
   *
   * "Already here" means ANY id the session answers to, not just its map key.
   * A caller that holds an older link in the rename chain — a room binding
   * persists the first SDK id it saw and keeps asking with it — was otherwise
   * handed a second session object for a conversation that is already live,
   * shadowing the real one on every later lookup (DOR-778). Once the session
   * is evicted its whole alias chain goes with it, so the same id asked again
   * is a genuine new session and is created as one.
   */
  ensureSession(sessionId: string, opts: SessionOpts): void {
    if (this.resolveMapKey(sessionId)) return;

    if (this.sessions.size >= SESSIONS.MAX_SESSIONS) {
      throw new Error(
        `Maximum session limit reached (${SESSIONS.MAX_SESSIONS}). ` +
          'Wait for existing sessions to expire or restart the server.'
      );
    }
    logger.debug('[ensureSession] creating new session', {
      session: sessionId,
      cwd: opts.cwd || '(empty)',
      permissionMode: opts.permissionMode,
      hasStarted: opts.hasStarted ?? false,
    });
    this.sessions.set(sessionId, {
      sdkSessionId: sessionId,
      lastActivity: Date.now(),
      permissionMode: opts.permissionMode,
      model: opts.model,
      effort: opts.effort,
      fastMode: opts.fastMode,
      cwd: opts.cwd,
      hasStarted: opts.hasStarted ?? false,
      ...(opts.unattended === true ? { unattended: true } : {}),
      pendingInteractions: new Map(),
      eventQueue: [],
    });
  }

  /**
   * Resolve or create a session for an incoming message.
   *
   * Handles auto-creation with transcript-based hasStarted detection
   * and deferred transcript checks from updateSession.
   *
   * The transcript probe answers two questions at once, and BOTH are kept:
   * whether the session has started (so the turn resumes rather than begins), and
   * which Claude account holds it (`accountRoot`) — the account that turn must
   * run and bill on, whichever one happens to be active. The probe already
   * resolved it; discarding it is what would make a resumed conversation land on
   * a different client's subscription (spec `claude-code-accounts` D3).
   */
  async ensureForMessage(
    sessionId: string,
    transcriptReader: TranscriptReader,
    defaultCwd: string,
    opts?: MessageOpts
  ): Promise<AgentSession> {
    const existing = this.findSession(sessionId);
    if (!existing) {
      const effectiveCwd = opts?.cwd ?? defaultCwd;
      const transcript = await transcriptReader.hasTranscript(effectiveCwd, sessionId);
      // Hydrate settings from the durable store (ADR-0260) so a session whose
      // in-memory state was evicted/restarted keeps the operator's chosen mode,
      // model, effort, and toggles. Precedence: per-send override → persisted →
      // runtime default.
      const persisted = await this.settingsPort?.getSessionSettings(sessionId);
      logger.debug('[sendMessage] auto-creating session', {
        session: sessionId,
        hasTranscript: transcript.exists,
        accountRoot: transcript.root,
        cwd: effectiveCwd,
        hydratedPermissionMode: persisted?.permissionMode,
      });
      this.ensureSession(sessionId, {
        permissionMode:
          opts?.permissionMode ?? persisted?.permissionMode ?? this.defaultPermissionMode,
        model: opts?.model ?? persisted?.model,
        effort: opts?.effort ?? persisted?.effort,
        fastMode: opts?.fastMode ?? persisted?.fastMode,
        cwd: opts?.cwd,
        hasStarted: transcript.exists,
      });
      // Set after creation rather than through SessionOpts: the account is not
      // something a caller may choose, it is what the disk already decided.
      if (transcript.root) this.findSession(sessionId)!.accountRoot = transcript.root;
    } else if (existing.needsTranscriptCheck) {
      // updateSession auto-created with hasStarted=false — verify transcript on
      // disk. This path exists because updateSession can auto-create a session
      // with no cwd at all, so it is the FIRST place the account can be known.
      existing.needsTranscriptCheck = false;
      const effectiveCwd = opts?.cwd || existing.cwd || defaultCwd;
      const transcript = await transcriptReader.hasTranscript(effectiveCwd, sessionId);
      if (transcript.root) existing.accountRoot = transcript.root;
      if (transcript.exists) {
        logger.debug('[sendMessage] upgrading hasStarted for existing transcript', {
          session: sessionId,
          accountRoot: transcript.root,
        });
        existing.hasStarted = true;
      }
    }
    return this.findSession(sessionId)!;
  }

  /**
   * The Claude Code account an IN-PROCESS SDK helper must act in for this
   * session — the single answer both D8 call sites use (fork here,
   * rename in the runtime facade).
   *
   * A live session's own `accountRoot` first, since the transcript probe that
   * bound it already ran; else the same probe, for a session this server has
   * never held in memory (a rename from a cold sidebar row); else the active
   * account, because an unknown account means "the active one" and never an
   * error (spec D3).
   *
   * @param sessionId - DorkOS or SDK session id.
   * @param transcriptReader - Reader whose account probe answers for a cold session.
   * @param projectDir - The session's working directory, which keys the probe.
   * @returns An absolute Claude config directory.
   */
  async accountRootFor(
    sessionId: string,
    transcriptReader: TranscriptReader,
    projectDir: string
  ): Promise<string> {
    const live = this.findSession(sessionId)?.accountRoot;
    if (live) return live;
    const { root } = await transcriptReader.hasTranscript(projectDir, sessionId);
    return root ?? resolveActiveClaudeRoot();
  }

  /** Fork a session, creating a new independent copy of the conversation. */
  async forkSession(
    projectDir: string,
    sessionId: string,
    transcriptReader: TranscriptReader,
    opts?: { upToMessageId?: string; title?: string }
  ): Promise<Session | null> {
    const internalId = this.getInternalSessionId(sessionId) ?? sessionId;
    try {
      // `forkSession` runs IN-PROCESS and its options carry no config dir, so the
      // env lock is the only way to point it at the source session's account —
      // and the fork's own transcript is written under whatever account is
      // pinned, so getting this wrong would move a copy of a paying client's
      // conversation onto another client's account (spec D8).
      const accountRoot = await this.accountRootFor(sessionId, transcriptReader, projectDir);
      const result = await withClaudeConfigDir(accountRoot, () =>
        sdkForkSession(internalId, {
          dir: projectDir,
          upToMessageId: opts?.upToMessageId,
          title: opts?.title,
        })
      );
      logger.info('[forkSession] session forked', {
        source: sessionId,
        newSessionId: result.sessionId,
        accountRoot,
      });
      return transcriptReader.getSession(projectDir, result.sessionId);
    } catch (err) {
      logger.error('[forkSession] fork failed', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  /** Return true if the session is currently tracked in memory. */
  hasSession(sessionId: string): boolean {
    return !!this.findSession(sessionId);
  }

  /**
   * Update mutable session fields, auto-creating (hydrated from durable
   * settings) if the session isn't currently in memory. Always resolves
   * `true` — there is no "session does not exist" case for this runtime,
   * because the auto-create branch below handles it.
   */
  async updateSession(
    sessionId: string,
    opts: {
      permissionMode?: PermissionMode;
      model?: string;
      effort?: EffortLevel;
      fastMode?: boolean;
    }
  ): Promise<boolean> {
    let session = this.findSession(sessionId);
    if (!session) {
      // Auto-create with hasStarted=false — sendMessage will check the transcript
      // on disk before deciding whether to resume. Hydrate from the durable
      // store first (ADR-0260): a PATCH that touches only model/effort/fastMode
      // (or a title rename, which routes through here unconditionally) can be
      // the first thing to reach a session whose in-memory state was evicted or
      // the server restarted since. Without this, the auto-create silently
      // reset an ENFORCED bypassPermissions/plan session back to 'default'
      // while the DB row — and the cockpit's display overlay reading it —
      // kept showing the operator's real choice (DOR-1151). Precedence
      // mirrors `ensureForMessage`: per-call override → persisted → runtime
      // default.
      const persisted = await this.settingsPort?.getSessionSettings(sessionId);
      this.ensureSession(sessionId, {
        permissionMode:
          opts.permissionMode ?? persisted?.permissionMode ?? this.defaultPermissionMode,
        model: opts.model ?? persisted?.model,
        effort: opts.effort ?? persisted?.effort,
        fastMode: opts.fastMode ?? persisted?.fastMode,
        hasStarted: false,
      });
      session = this.findSession(sessionId)!;
      session.needsTranscriptCheck = true;
    }
    // Write-through: persist the operator's choice first so it is durable even
    // if the live query rejects the change or the session is later evicted
    // (ADR-0260). Only user-driven PATCHes reach updateSession, so transient
    // per-send overrides (Tasks/relay) are never persisted here.
    await this.settingsPort?.saveSessionSettings(sessionId, opts);
    if (opts.permissionMode) {
      const prevMode = session.permissionMode;
      session.permissionMode = opts.permissionMode;
      if (session.activeQuery) {
        const query = session.activeQuery;
        // Bounded (DOR-1301): on a session winding down, DorkOS has already
        // ended this query's stdin, so the SDK drops the write in silence and
        // returns a promise nothing will settle. Awaiting it hung the PATCH —
        // and made the best-effort catch below unreachable, since a dropped
        // write never rejects either. The clock is what makes the best-effort
        // contract true rather than merely written down.
        const ack = await awaitControlAck(
          () =>
            query.setPermissionMode(
              opts.permissionMode as Parameters<typeof query.setPermissionMode>[0]
            ),
          PERMISSION_MODE_ACK_TIMEOUT_MS
        );
        if (ack !== 'acked') {
          // Best-effort (ADR-0261): keep the new mode even when the live query
          // refuses the change or never answers — it is already persisted
          // (write-through above) and takes effect on the next turn. Never
          // revert or re-throw, so the PATCH route does not surface a spurious
          // 422.
          logger.warn('[updateSession] live setPermissionMode did not take; applies next turn', {
            sessionId,
            mode: opts.permissionMode,
            ack,
          });
        }
      }
      logger.debug('[updateSession] permissionMode change', {
        sessionId,
        from: prevMode,
        to: opts.permissionMode,
      });
    }
    if (opts.model) session.model = opts.model;
    if (opts.effort) session.effort = opts.effort;
    if (opts.fastMode !== undefined) session.fastMode = opts.fastMode;
    return true;
  }

  // ---------------------------------------------------------------------------
  // Interactive flows
  // ---------------------------------------------------------------------------

  /**
   * Approve or deny a pending tool call.
   *
   * `alwaysAllow` forwards the SDK's permission suggestions; `denyReason`
   * rides the refusal into the message the model reads, so a person who
   * explained themselves is heard rather than merely obeyed.
   */
  approveTool(
    sessionId: string,
    toolCallId: string,
    approved: boolean,
    options?: ToolDecisionOptions
  ): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'approval') return false;

    if (approved && options?.alwaysAllow && pending.suggestions?.length) {
      // "Always Allow" — pass the SDK permission suggestions array
      pending.resolve(pending.suggestions);
    } else {
      pending.resolve(approved, approved ? undefined : options?.denyReason);
    }
    return true;
  }

  /** Submit answers to a pending AskUserQuestion interaction. */
  submitAnswers(sessionId: string, toolCallId: string, answers: Record<string, string>): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(toolCallId);
    if (!pending || pending.type !== 'question') return false;
    pending.resolve(answers);
    return true;
  }

  /** Submit a response to an MCP elicitation prompt. */
  submitElicitation(
    sessionId: string,
    interactionId: string,
    action: 'accept' | 'decline' | 'cancel',
    content?: Record<string, unknown>
  ): boolean {
    const session = this.findSession(sessionId);
    const pending = session?.pendingInteractions.get(interactionId);
    if (!pending || pending.type !== 'elicitation') return false;
    pending.resolve({
      action,
      content: content as Record<string, string | number | boolean | string[]> | undefined,
    });
    return true;
  }

  /**
   * Stop a running background task, bounded like every other stop (DOR-1244).
   *
   * `stop_task` is a control request, so it hangs on a CLI whose stdin DorkOS
   * has already ended exactly as `interrupt()` does. Past the bound this
   * reports failure and leaves the turn alone — deliberately NOT escalating to
   * `close()`, because the button asked to end ONE background task and killing
   * the subprocess would take the whole turn with it.
   */
  async stopTask(sessionId: string, taskId: string): Promise<boolean> {
    const session = this.findSession(sessionId);
    const query = session?.activeQuery;
    if (!session || !query) return false;
    // Like interruptQuery: an operator-driven cancellation may surface as the
    // CLI's interrupt sentinel on the task's pending calls — stamp it so the
    // phantom detector (DOR-1087) treats those as legitimate.
    session.interruptRequestedAt = Date.now();
    const ack = await awaitControlAck(() => query.stopTask(taskId), STOP_ACK_TIMEOUT_MS);
    if (ack === 'acked') return true;
    logger.warn('[stopTask] the CLI did not stop the task', { sessionId, taskId, ack });
    // Only a REFUSAL clears the stamp. A refusal is the CLI saying the stop did
    // not happen, so a sentinel arriving afterwards really is a phantom. An
    // unacked request is not an answer at all: the CLI may still be about to
    // honour it, and cancelling the task's pending calls a second past the bound
    // would then produce sentinels with nothing on record — the operator would
    // be told "that was a system glitch, not you" about a stop they asked for,
    // the model would be steered a correction it should not get, and the
    // DOR-1288 tripwire would count a phantom that never was. The stamp expires
    // on its own after `INTERRUPT_SUPPRESSION_WINDOW_MS` and is cleared at the
    // next turn start, so leaving it costs nothing beyond that window.
    if (ack === 'refused') session.interruptRequestedAt = undefined;
    return false;
  }

  /**
   * Interrupt the active query for a session.
   *
   * Tries `query.interrupt()` first (graceful), bounded; escalates to
   * `query.close()` when that is refused or goes unacknowledged.
   */
  async interruptQuery(sessionId: string): Promise<boolean> {
    const session = this.findSession(sessionId);
    if (!session?.activeQuery) return false;
    return this.interruptGivenQuery(sessionId, session.activeQuery);
  }

  /**
   * Interrupt a SPECIFIC query for a session — **the bounded Stop** every
   * caller here ends up in (the cockpit's button, a room's halt, the stall
   * watchdog, a Stop during launch).
   *
   * **The property: Stop is bounded.** A graceful `interrupt()` that is neither
   * answered nor refused inside `STOP_ACK_TIMEOUT_MS` is abandoned and the
   * process is closed, so the turn ends within that window whatever the CLI is
   * doing. Waiting on the ack alone was unbounded in the one case where it
   * matters most — a turn winding down, whose stdin DorkOS itself has closed,
   * where the SDK drops the request in silence and the promise behind it is
   * settled by nothing (DOR-1244; the mechanics are in `bounded-control.ts`).
   *
   * Split out of {@link interruptQuery} so the persistent path can stop a turn
   * that is still BOOTING — one whose live query the pump holds before its
   * `running` edge has armed `session.activeQuery` (DOR-1191). Same escalation,
   * same phantom-cancellation stamp, so a Stop during launch behaves exactly as
   * a Stop on a turn that has already reached the model.
   *
   * The persistent path pays the full bound whichever phase it is in: only the
   * resume path records `stdinEndedQueries`, because only it ends a CLI's stdin
   * mid-session (the pump deliberately never does, `persistent-dispatch.ts`).
   * That is the right default there — a needless `close()` costs that path a
   * warm process — and it is why the fast path below is not simply assumed.
   *
   * @param sessionId - The session the query belongs to
   * @param query - The live query to interrupt
   * @returns True when the turn was interrupted or the process was closed, false
   *   when neither path took and the session is unknown
   */
  async interruptGivenQuery(sessionId: string, query: Query): Promise<boolean> {
    const session = this.findSession(sessionId);
    if (!session) return false;
    // A deliberate stop is about to cancel every pending tool call; stamp it so
    // the phantom-cancellation detector (DOR-1087) treats the resulting CLI
    // interrupt sentinels as legitimate rather than phantoms. It SURVIVES the
    // escalation below on purpose: a `close()` produces exactly those sentinels,
    // and they are as deliberate as an interrupt's would have been.
    session.interruptRequestedAt = Date.now();
    // Recorded BEFORE the attempt, so a Stop still in flight when the turn's
    // stream ends is already on record: the send loop reads this to settle a
    // stopped turn as `interrupted` rather than idle (DOR-1244).
    (session.stoppedQueries ??= new WeakSet()).add(query);
    // DorkOS ended this query's stdin itself, so nothing it writes can arrive
    // and no ack can come back. Skip a graceful attempt already known to be
    // undeliverable rather than spending the bound proving it again. Matched by
    // IDENTITY, never per-session: overlapping turns share a session, and the
    // outgoing turn's close must not condemn its successor (DOR-1088).
    if (session.stdinEndedQueries?.has(query) === true) {
      logger.info('[interruptQuery] stdin already ended; closing without a graceful attempt', {
        sessionId,
      });
      return this.closeStoppedQuery(session, query);
    }
    // Measured, because the bound alone never said where a slow Stop went
    // (DOR-1319). A Stop seen at 7.6 s could have been a 3 s ack plus a 4.5 s
    // unwind, or a fast ack and a very slow unwind, and nothing on record could
    // tell the two apart — so nobody could say whether the number to change was
    // this bound or something else entirely.
    const askedAt = Date.now();
    const ack: ControlAck = await awaitControlAck(() => query.interrupt(), STOP_ACK_TIMEOUT_MS);
    const ackMs = Date.now() - askedAt;
    if (ackMs >= STOP_ACK_SLOW_MS) {
      logger.warn('[interruptQuery] the stop took a long time to be heard', {
        sessionId,
        ack,
        ackMs,
        boundMs: STOP_ACK_TIMEOUT_MS,
      });
    } else {
      logger.debug('[interruptQuery] stop acked', { sessionId, ack, ackMs });
    }
    if (ack === 'acked') return true;
    logger.warn('[interruptQuery] the graceful interrupt did not take; closing the process', {
      sessionId,
      ack,
    });
    return this.closeStoppedQuery(session, query);
  }

  /**
   * The escalation itself: kill the subprocess, and report whether anything at
   * all stopped the turn.
   *
   * `session.interruptRequestedAt` deliberately SURVIVES a successful close — the
   * sentinels the close produces on every pending tool call are as deliberate as
   * an interrupt's would have been, and the phantom detector (DOR-1087) has to
   * read them that way. It is cleared only when the close itself throws, because
   * then nothing stopped the turn and a sentinel really would be a phantom.
   *
   * @param session - The live session, for the phantom-cancellation stamp
   * @param query - The query to close
   * @returns True when the process was closed, false when even that failed
   */
  private closeStoppedQuery(session: AgentSession, query: Query): boolean {
    try {
      query.close();
      return true;
    } catch {
      // Neither path stopped the turn — do not blind the phantom detector.
      session.interruptRequestedAt = undefined;
      return false;
    }
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  /**
   * Evict sessions that have exceeded their idle timeout. Returns EVERY id the
   * session answered to — its map key (the original request UUID) plus every
   * SDK id it was ever renamed to. All of them are returned because
   * `rekeyProjector` moves a brand-new session's projector from the request
   * UUID to the canonical id mid-first-turn, so disposing by the map key alone
   * would miss every rekeyed projector and leak it (plus its EventLog) for the
   * server's lifetime. Locks may exist under any of them too; `cleanup` is
   * delete-if-present, so passing them all is safe.
   *
   * The reverse index is swept the same way — by value, not by the current
   * `sdkSessionId` — because a twice-renamed session keeps an entry per id it
   * has held, and deleting only the newest would leave the older ones pointing
   * at a map key that no longer exists, for the life of the server.
   *
   * The pump's eviction depends on this too, not only the projector
   * (`ClaudeCodeRuntime.checkSessionHealth` loops `pumps.evict` over every id
   * returned here). By the time that loop runs, THIS session's row and every
   * one of its reverse-index entries are already gone — `sessionKeyOf` can no
   * longer resolve an alias back to the map key, and falls back to whatever id
   * it was asked with instead. So the ORIGINAL map key must be in this list
   * for eviction to ever reach the `SessionPumpRegistry` entry that key
   * actually owns (it always is — `ids` is seeded with it, above). Narrowing
   * this to "the canonical id is enough" would silently strand a warm
   * subprocess on every eviction, because no alias would resolve to the key
   * that finds it (DOR-1309).
   */
  checkSessionHealth(lockManager: SessionLockManager): string[] {
    const now = Date.now();
    const expiredIds: string[] = [];
    for (const [id, session] of this.sessions) {
      if (now - session.lastActivity <= this.SESSION_TIMEOUT_MS) continue;
      // A session parked on a person is not idle, it is waiting, and evicting
      // it throws away the very tool call the person is coming back to answer.
      // `lastActivity` is stamped at creation and at each turn, never during a
      // wait, so without this the real ceiling on any wait would be thirty
      // minutes from turn start and a four-hour park would be a lie. Bounded by
      // the park ceiling rather than by the interaction, so a STRANDED entry
      // cannot make a record immortal: it ages out on the same clock the
      // selector and the stall watchdog use. `startedAt`, not a parked flag,
      // because the exemption is right for the whole wait, not only its second
      // half (spec `ask-parks-on-timeout` §8).
      if (isWaitingOnPerson(session, now)) continue;
      for (const interaction of session.pendingInteractions.values()) {
        clearTimeout(interaction.timeout);
      }
      const ids = new Set<string>([id]);
      for (const [sdkId, mapKey] of this.sdkSessionIndex) {
        if (mapKey === id) {
          this.sdkSessionIndex.delete(sdkId);
          ids.add(sdkId);
        }
      }
      if (session.sdkSessionId) ids.add(session.sdkSessionId);
      this.sessions.delete(id);
      expiredIds.push(...ids);
    }
    lockManager.cleanup(expiredIds);
    return expiredIds;
  }

  /** Return the backend-internal session ID (SDK session ID) for a DorkOS session ID. */
  getInternalSessionId(sessionId: string): string | undefined {
    return this.findSession(sessionId)?.sdkSessionId;
  }

  /**
   * Backward-compatible alias for `getInternalSessionId`.
   *
   * @deprecated Use `getInternalSessionId()` instead.
   */
  getSdkSessionId(sessionId: string): string | undefined {
    return this.getInternalSessionId(sessionId);
  }
}
