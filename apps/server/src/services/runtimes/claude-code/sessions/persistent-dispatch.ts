/**
 * The composition root of the persistent pump: where the opt-in is read, where
 * every P3 module is wired to its neighbour, and where a turn on a warm process
 * becomes the same `StreamEvent` stream a turn on a fresh one always was (spec
 * `persistent-session-runtime` §P3, task 3.10 / DOR-1175).
 *
 * ```
 *                        isPersistentSessionEnabled()          ← read here, per acquire
 *                                    │
 *   sendMessage ─────────────────────┴──────────────► executeSdkQuery   (flag off)
 *        │
 *        ▼  (flag on, or a process already held)
 *   PersistentDispatch.dispatch
 *        ├─ resolveLaunch ......... the same options the other path builds
 *        ├─ validateDispatchBoundary ... the cwd it will also hand the launcher
 *        ├─ decideProcessReuse .... ride / adjust live / replace the process
 *        └─ SessionCrashRecovery.dispatch
 *                 └─ SessionTurnWindows.dispatch   ← boundary asked again; the ingress
 *                          └─ SessionPump.dispatch
 *                                   └─ createPumpLauncher → query()
 * ```
 *
 * ## The opt-in is asymmetric, and P5's comparison runs depend on knowing it
 *
 * `SessionPumpRegistry.acquire` returns an existing pump without re-reading the
 * flag, and a pump SURVIVES its own crash (its recovery is a relaunch of the
 * same pump). So:
 *
 * - **Off → on** takes effect at the session's next message. Nothing existing
 *   changes; the next dispatch finds no process, reads the flag, and launches.
 * - **On → off** does NOT take a warm session back. It keeps its process — and
 *   keeps taking this path — until that process goes away on its own: the idle
 *   reap, an eviction, a warm-ceiling reclaim, or a server restart. Only then
 *   does the next message re-read the flag and find it off.
 *
 * That is deliberate rather than tolerated. A session mid-conversation must not
 * have its process pulled out from under it by a settings change, and the flag
 * is documented to the operator as governing the next process rather than the
 * one already running (`contributing/configuration.md`). It does mean a
 * measurement run that flips the flag off has to reap, evict, or restart before
 * it can claim it is measuring the resume path.
 *
 * ## Why there is no `TurnWindowSignal` here
 *
 * Task 3.7 built one, and this composition deliberately does not construct it.
 * The signal exists so a stall watchdog can follow turn windows when ONE
 * `StreamEvent` stream carries MANY turns. That is not the shape of this
 * composition: {@link PersistentDispatch.dispatch} is called once per message
 * and its generator ends when that message's window ends, so the stream handed
 * to `withStallGuard` still has exactly one turn's lifetime — the same as the
 * resume path, and the guard is already correct without being told anything.
 *
 * Wiring the signal in anyway would make the guard STRICTLY WORSE here: it
 * would disarm the clock during the launch, before the first window opens, and
 * `withStallGuard` is already the only guard on this stream. A second one is
 * the double-guard the P3.7 review warned against.
 *
 * The signal earns its keep the moment a turn's events can arrive on a stream
 * that outlives the turn — P4's `deliverIntoTurn`, where a steer's output lands
 * in a window already open. It stays exactly where it is until then.
 *
 * ## Runtime windows are drained, never projected
 *
 * `SessionTurnWindows` opens a synthetic `origin: 'runtime'` window for a
 * `result` nobody dispatched. Nothing here consumes it as a turn, because the
 * only consumer of a window on this path is the `sendMessage` generator that
 * asked for one — so a runtime window is drained and dropped, with a warning.
 * That keeps projection SERIALIZED per session by construction, which is the
 * P3.3 review's first option: one window is projected at a time, and the
 * interleave two genuinely-open windows could produce (a `turn_end` for one
 * arriving after a `turn_start` for the next) cannot occur, because the second
 * window is never projected at all. Draining rather than ignoring matters: an
 * unread channel is a buffer nobody empties.
 *
 * @module services/runtimes/claude-code/sessions/persistent-dispatch
 */
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@dorkos/shared/types';
import type { MessageOpts } from '@dorkos/shared/agent-runtime';
import { SESSIONS } from '../../../../config/constants.js';
import { logger } from '../../../../lib/logger.js';
import type { AgentSession } from '../agent-types.js';
import { boundaryViolationEvent, validateDispatchBoundary } from '../dispatch-boundary.js';
import { resolveEffectiveCwd, resolveLaunch } from '../messaging/launch-resolver.js';
import type { MessageSenderOpts } from '../messaging/message-sender-shared.js';
import { isPersistentSessionEnabled } from '../persistent-session-optin.js';
import {
  AccountPinViolationError,
  captureLaunchFingerprint,
  type LaunchFingerprint,
} from './launch-fingerprint.js';
import { createPumpLauncher, decideProcessReuse, type PumpLaunchPlan } from './pump-launch.js';
import { streamTurnWindow } from './pump-turn-stream.js';
import { SessionCrashLoopError, SessionCrashRecovery } from './session-crash-recovery.js';
import { PumpRefusedError } from './session-pump-contract.js';
import type { SessionPump } from './session-pump.js';
import type { SessionPumpRegistry } from './session-pump-registry.js';
import { SessionTurnWindows, type TurnWindow } from './session-turn-windows.js';

/** One session's pump, its windower, and its crash policy, wired together. */
interface SessionBundle {
  pump: SessionPump;
  windows: SessionTurnWindows;
  recovery: SessionCrashRecovery;
  /** What the live process was launched with; `undefined` until one boots. */
  fingerprint: LaunchFingerprint | undefined;
  /** The plan of the dispatch currently in flight, read by the launcher. */
  plan: PumpLaunchPlan | undefined;
}

/** What one dispatch needs beyond the session itself. */
export interface PersistentDispatchArgs {
  sessionId: string;
  content: string;
  session: AgentSession;
  opts: MessageSenderOpts;
  messageOpts?: MessageOpts;
}

/**
 * Turn a failure that happened before any output into the same terminal pair a
 * turn error always produces, so the projector settles rather than pinning
 * `streaming` on a turn that never ran.
 */
function* terminalFailure(
  sessionId: string,
  message: string,
  details?: string
): Generator<StreamEvent> {
  yield {
    type: 'error',
    data: {
      message,
      category: 'execution_error',
      ...(details !== undefined ? { details } : {}),
    },
  };
  yield { type: 'done', data: { sessionId } };
}

/**
 * Every claude-code session that holds its process open, and the one path a
 * message takes to reach one.
 *
 * Constructed once per runtime, over the runtime's own pump registry — the same
 * registry `getSessionWarmth`, `reapSession` and session eviction already read,
 * so warmth is answered by the thing that actually owns the processes.
 */
export class PersistentDispatch {
  private readonly registry: SessionPumpRegistry;
  private readonly bundles = new Map<string, SessionBundle>();

  /**
   * Build the dispatcher over a runtime's pump registry.
   *
   * @param registry - The runtime's registry; this never creates its own, so
   *   warmth and reaping answer about the same processes turns run on
   */
  constructor(registry: SessionPumpRegistry) {
    this.registry = registry;
  }

  /**
   * Should this message run on a held process?
   *
   * The flag is read HERE, immediately before the pump is acquired, which is
   * what makes the opt-in per-session rather than per-host: a session that
   * already holds a process keeps the path it started on, whatever the setting
   * says now. See the module doc for what that means in each direction.
   *
   * @param sessionId - The session about to dispatch
   */
  shouldDispatch(sessionId: string): boolean {
    if (this.registry.peek(sessionId) !== undefined) return true;
    return isPersistentSessionEnabled();
  }

  /**
   * Forget a session's wiring. Called when its process is dropped for good, so
   * the next message builds a fresh pump rather than dispatching into a spent
   * one.
   *
   * @param sessionId - The session going away
   */
  forget(sessionId: string): void {
    this.bundles.delete(sessionId);
  }

  /**
   * Run one message as a turn on this session's held process.
   *
   * @param args - The session, its message, and the runtime's ports
   */
  async *dispatch(args: PersistentDispatchArgs): AsyncGenerator<StreamEvent> {
    const { sessionId, content, session, opts, messageOpts } = args;
    session.lastActivity = Date.now();
    session.eventQueue = [];
    // Clear last turn's breakdown so a failed fetch this turn never shows stale
    // data, and a stop stamped in a PREVIOUS turn must not blind this turn's
    // phantom detector (DOR-1087).
    session.contextBreakdown = undefined;
    session.interruptRequestedAt = undefined;

    // The ONE cwd resolution, handed to the gate below AND to the launcher
    // through the plan — the identity `dispatch-boundary.ts` requires, and the
    // reason the gate is not asked twice by two different routes.
    const effectiveCwd = resolveEffectiveCwd(opts, messageOpts);
    try {
      await validateDispatchBoundary(effectiveCwd);
    } catch {
      // Asked HERE as well as inside the windower, and the redundancy is
      // deliberate. The windower's gate is the ingress invariant — it holds for
      // every caller, including the crash-recovery re-dispatch. This one exists
      // so a refused turn cannot first cost the person their warm process: a
      // moved cwd is a relaunch pin, so without it the pin comparison below
      // would tear the process down and only then be refused.
      logger.warn('[persistent-dispatch] boundary violation', { session: sessionId, effectiveCwd });
      yield boundaryViolationEvent(effectiveCwd);
      return;
    }

    const resolved = await resolveLaunch({
      sessionId,
      content,
      session,
      opts,
      ...(messageOpts !== undefined ? { messageOpts } : {}),
      effectiveCwd,
    });
    const plan: PumpLaunchPlan = {
      effectiveCwd,
      enrichedContent: resolved.enrichedContent,
      meshAgentId: resolved.meshAgentId,
      statusEvents: resolved.statusEvents,
      sdkOptions: resolved.sdkOptions,
      fingerprint: captureLaunchFingerprint(resolved.launch),
    };

    let bundle = this.acquire(sessionId, session);
    // Nothing pinned to the live process may be stale by the time the turn
    // opens. A pin the SDK cannot set live replaces the process outright; the
    // four it can are awaited, never fired blind (`launch-live-settings.ts`).
    const reuse = decideProcessReuse(bundle.fingerprint, plan.fingerprint);
    if (reuse.action === 'replace') {
      logger.info('[persistent-dispatch] replacing a warm process', {
        session: sessionId,
        reason: reuse.reason,
      });
      await this.replaceProcess(sessionId);
      bundle = this.acquire(sessionId, session);
    } else if (reuse.action === 'adjust') {
      const control = bundle.pump.controlQuery;
      if (control === undefined) {
        // The process went away between the comparison and here. Nothing to
        // adjust and nothing stale to ride: the dispatch below relaunches.
        bundle.fingerprint = undefined;
      } else {
        try {
          await reuse.apply(control);
          bundle.fingerprint = reuse.to;
        } catch (err) {
          if (err instanceof AccountPinViolationError) {
            logger.error('[persistent-dispatch] refused a cross-account dispatch', {
              session: sessionId,
              error: err.message,
            });
            yield* terminalFailure(
              sessionId,
              'This chat belongs to a different Claude account than the one its agent is running on, so the message was not sent. Restart the chat to run it on the right account.',
              err.message
            );
            return;
          }
          throw err;
        }
      }
    }

    bundle.plan = plan;
    for (const event of plan.statusEvents) yield event;

    let window: TurnWindow;
    try {
      window = await bundle.recovery.dispatch(
        [{ content: plan.enrichedContent, messageId: messageOpts?.messageId ?? randomUUID() }],
        effectiveCwd
      );
    } catch (err) {
      yield* this.explainRefusedDispatch(sessionId, err);
      return;
    }

    yield* streamTurnWindow({
      sessionId,
      session,
      window,
      opts,
      meshAgentId: plan.meshAgentId,
    });
  }

  /**
   * Say why a dispatch never reached the process, in words a person can act on.
   *
   * Every one of these leaves the durable queue alone, which is the whole point:
   * a row retires on correlated OUTPUT evidence — the `turn_start` a window
   * mints — and none of these produced one, so the person's message is still
   * theirs (`session-crash-recovery.ts`).
   */
  private *explainRefusedDispatch(sessionId: string, err: unknown): Generator<StreamEvent> {
    if (err instanceof SessionCrashLoopError) {
      // The raw error leads with the session id, which is a UUID nobody reads.
      // The operator gets the plain sentence; the id stays in `details` and in
      // the warning `SessionCrashRecovery` already logged.
      yield* terminalFailure(
        sessionId,
        `This chat's agent keeps stopping, so DorkOS did not start it again. ${
          err.crash?.message ?? 'It ended without saying why.'
        } Send the message again to try once more.`,
        err.message
      );
      return;
    }
    if (err instanceof PumpRefusedError && err.reason === 'warm-ceiling') {
      yield* terminalFailure(
        sessionId,
        `Too many chats are holding an agent open right now (the limit is ${SESSIONS.MAX_WARM_SESSIONS}). Finish or close one and send this again.`,
        err.message
      );
      return;
    }
    if (err instanceof PumpRefusedError && err.reason === 'pending-interaction') {
      yield* terminalFailure(
        sessionId,
        'This chat is waiting on an answer from you, so the message was not sent yet. Answer the open request and send it again.',
        err.message
      );
      return;
    }
    // Anything else is a genuine failure to launch or dispatch. Rethrow so
    // `guardTurnErrors` translates it exactly as it does on the resume path —
    // one place owns the generic translation, not two.
    throw err;
  }

  /**
   * This session's wiring, built on first use.
   *
   * The three collaborators reference each other — the pump's observers reach
   * the windower and the recovery, and the recovery dispatches back through the
   * windower — so the bundle is created empty and filled in place. It stays ONE
   * object throughout: the launcher writes this session's fingerprint into it,
   * and a copy would mean that write landed somewhere nothing consults.
   */
  private acquire(sessionId: string, session: AgentSession): SessionBundle {
    const existing = this.bundles.get(sessionId);
    // Held to the REGISTRY's answer, not to the map's, because the registry
    // drops pumps this class never hears about: the idle timer reaps one after
    // five quiet minutes, and a warm-ceiling reclaim takes the least recently
    // used. A reaped pump is spent — it refuses everything asked of it — so a
    // bundle still pointing at one would turn the next message into an illegal
    // transition instead of a fresh launch. Identity, not presence: a pump the
    // registry replaced is as stale as one it dropped.
    if (existing !== undefined && this.registry.peek(sessionId) === existing.pump) return existing;

    // Definitely-assigned three lines down. Nothing can observe the gap: the
    // pump boots nothing until it is dispatched to, which cannot happen before
    // this function returns.
    const bundle = { fingerprint: undefined, plan: undefined } as unknown as SessionBundle;

    bundle.pump = this.registry.acquire(sessionId, {
      maxWarmSessions: SESSIONS.MAX_WARM_SESSIONS,
      warmIdleMs: SESSIONS.WARM_IDLE_MS,
      launch: createPumpLauncher(
        session,
        () => {
          const plan = bundle.plan;
          if (plan === undefined) {
            // A launch with no plan would boot a process with no options at
            // all. Nothing can reach here — the pump only launches from inside
            // a dispatch, and `dispatch` parks the plan first — so this is a
            // caller-bug guard, not a fallback.
            throw new PumpRefusedError(
              'process-gone',
              `session ${sessionId} tried to launch with no resolved plan`
            );
          }
          return plan;
        },
        (fingerprint) => {
          bundle.fingerprint = fingerprint;
        }
      ),
      onMessage: (message) => bundle.windows.onMessage(message),
      onCrash: (crash) => {
        bundle.fingerprint = undefined;
        // The process is gone, so the control channel on the session is stale.
        // Left in place it would answer nothing, and a Stop would report success
        // against a dead query.
        if (session.activeQuery !== undefined) {
          session.lastQuery = session.activeQuery;
          session.activeQuery = undefined;
        }
        bundle.recovery.handleCrash(crash);
      },
      onStateChange: (change) => bundle.recovery.noteStateChange(change),
      hasPendingInteraction: () => session.pendingInteractions.size > 0,
    });

    bundle.windows = new SessionTurnWindows({
      sessionId,
      pump: bundle.pump,
      onWindowOpen: (window) => {
        // A window nobody dispatched has no consumer here. Its channel would
        // otherwise buffer a whole synthetic turn that nothing ever reads.
        if (window.origin === 'runtime') void drainUnprojected(sessionId, window);
      },
      onUsage: (usage) => {
        // Delivered BEFORE the window's `result` is released, so `context_usage`
        // still precedes `done` exactly as it does on the resume path.
        if (usage.context) session.contextBreakdown = usage.context;
        // `undefined` keeps the last known value: the item must never flicker
        // back to cost-only between turns.
        if (usage.subscription) session.lastSubscriptionUsage = usage.subscription;
      },
    });

    bundle.recovery = new SessionCrashRecovery({
      sessionId,
      pump: bundle.pump,
      windows: bundle.windows,
    });

    this.bundles.set(sessionId, bundle);
    return bundle;
  }

  /**
   * Close this session's process and forget its wiring, so the next dispatch
   * launches a fresh one under the values it resolved.
   *
   * `evict` rather than `reap`: a reap is polite and may decline, and a pin that
   * moved is not a request. Nothing is running — the windower refuses a
   * dispatch while a window is open — so there is no turn to interrupt.
   */
  private async replaceProcess(sessionId: string): Promise<void> {
    await this.registry.evict(sessionId);
    this.forget(sessionId);
  }
}

/**
 * Read a window nothing will project, so its buffer empties and its close can
 * settle. Never yields the messages anywhere: see the module doc.
 */
async function drainUnprojected(sessionId: string, window: TurnWindow): Promise<void> {
  let dropped = 0;
  try {
    for await (const _message of window.messages) dropped += 1;
  } catch (err) {
    logger.debug('[persistent-dispatch] a runtime window failed while draining', {
      sessionId,
      err,
    });
  }
  logger.warn('[persistent-dispatch] dropped a turn nobody asked for', { sessionId, dropped });
}
