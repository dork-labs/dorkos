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
 * ## Why there is STILL no `TurnWindowSignal` here — settled by P4's steer
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
 * P3 named `deliverIntoTurn` as the signal's genuine first caller, on the
 * expectation that a steer's events would arrive on a stream that OUTLIVES the
 * turn that opened it. Task 4.1 implemented the steer and that expectation did
 * not materialize: a steer ({@link PersistentDispatch.steer}) pushes into the
 * OPEN window's held stream, so its events land in the window already open and
 * on the same `streamTurnWindow` generator, which still ends at that turn's one
 * `result`. A steer makes a turn LONGER, not a stream carry more than one turn —
 * every steered event is activity `withStallGuard` already sees on the one
 * stream it already guards. So the signal stays unwired and unconstructed; the
 * shape that would need it (one stream, several concurrently-open turns) still
 * does not exist on this path.
 *
 * ## Every entry point resolves to ONE key before touching `bundles`
 *
 * A session answers to more than one id across its life: the request UUID a
 * first turn warmed it under, and the canonical id the SDK re-mints on that
 * same turn's `system/init` (ADR-0267) — and the client learns the canonical
 * id from that turn's 202, so its VERY NEXT message is sent under it. Every
 * method below that touches {@link bundles} therefore resolves its
 * caller-supplied id through {@link sessionKeyOf} first — `dispatch`, `steer`,
 * `stage`, `forget`, `bootingQuery`, `settleOpenTurn` — rather than keying by
 * whatever id happened to arrive. `SessionPumpRegistry` does the same for its
 * own map (see its module doc), off the SAME resolver, so the two structures
 * this class wires together can never learn about a rekey at different times.
 *
 * `SessionStore.sessionKeyOf` is that resolver, and there is exactly one of
 * it, injected at construction, because before this existed there were three
 * candidates for "which id is a session's pump filed under" — the map key
 * `bundles` used, the map key the registry used, and the alias graph
 * `SessionStore` already kept for its own reverse index — and the first two
 * never consulted the third. Turn 1 warmed a process under the request UUID;
 * the rebind updated only `SessionStore`'s own index; turn 2's POST, sent
 * under the canonical id the 202 had just taught the client, missed both this
 * class's `bundles` and the registry's `entries`, and `dispatch` minted a
 * SECOND process for what the person experienced as one conversation — the
 * orphan then held its memory until the idle reaper, five minutes later
 * (DOR-1309). A steer or a stage under the other id failed the same way,
 * which is the shared root of DOR-1315's second-window steer and DOR-1318's
 * "failed to warm" on an idle session addressed by its canonical id.
 *
 * Resolving here, once, is deliberately preferred over teaching `bundles` and
 * `entries` to REKEY themselves on the `onSdkSessionRebind` announcement (the
 * shape DOR-1262 used for the projector registry's retired→canonical
 * redirect). A redirect map is a second alias graph to keep in sync with
 * `SessionStore`'s; a shared resolver has only one. Nothing here needs its OWN
 * copy of "which ids has this session answered to" — `SessionStore` already
 * has to know that for `rebindSdkSession` and `findSession`, so this class and
 * the registry just ask it.
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
 * What gets drained is CENSUSED, and the two outcomes are reported differently
 * (DOR-1314). A window carrying only a `result` and a `system` line is the CLI
 * volunteering bookkeeping — routine, and logged at debug with what it held. A
 * window carrying model speech is words a person was owed, and that is an
 * error, not a shrug. The steer case that made it routine is fixed upstream in
 * `SessionTurnWindows`: a steered window now waits to see whether the CLI gave
 * the steer a turn of its own, so that turn lands INSIDE the person's window
 * instead of in a runtime one nothing projects.
 *
 * @module services/runtimes/claude-code/sessions/persistent-dispatch
 */
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@dorkos/shared/types';
import type {
  DeliverIntoTurnOpts,
  MessageOpts,
  RuntimeDeliveryResult,
} from '@dorkos/shared/agent-runtime';
import type { AdditionalContext } from '@dorkos/shared/additional-context';
import { renderContextEntry } from '../messaging/context-builder.js';
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
import { isWaitingOnPerson } from './session-store.js';
import { PumpRefusedError } from './session-pump-contract.js';
import type { Query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { SessionPump } from './session-pump.js';
import type { SessionPumpRegistry } from './session-pump-registry.js';
import { SessionTurnWindows, type TurnWindow } from './session-turn-windows.js';

/** One session's pump, its windower, and its crash policy, wired together. */
interface SessionBundle {
  pump: SessionPump;
  windows: SessionTurnWindows;
  recovery: SessionCrashRecovery;
  /**
   * The running process's query, or `undefined` when this session holds none.
   *
   * Held here rather than on the session, because `session.activeQuery` means
   * something narrower — see {@link SessionBundle.fingerprint}'s neighbour in
   * `acquire`, where the two are kept apart.
   */
  live: Query | undefined;
  /** What the live process was launched with; `undefined` until one boots. */
  fingerprint: LaunchFingerprint | undefined;
  /** The plan of the dispatch currently in flight, read by the launcher. */
  plan: PumpLaunchPlan | undefined;
  /**
   * True while a turn is BOOTING on this session — the launch is in flight and
   * the pump has not yet reached its `running` edge, so `session.activeQuery` is
   * not armed. This is the one window where a Stop cannot reach the turn through
   * the ordinary path, so {@link PersistentDispatch.bootingQuery} exposes
   * {@link SessionBundle.live} to it (DOR-1191). Distinct from a merely-warm
   * idle process, which is never booting a turn and must never be interrupted.
   */
  booting: boolean;
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
  private readonly sessionKeyOf: (sessionId: string) => string;
  private readonly bundles = new Map<string, SessionBundle>();

  /**
   * Build the dispatcher over a runtime's pump registry.
   *
   * @param registry - The runtime's registry; this never creates its own, so
   *   warmth and reaping answer about the same processes turns run on. Given
   *   the SAME `sessionKeyOf` resolver, so the two structures resolve a rekey
   *   identically (see the module doc).
   * @param sessionKeyOf - The single answer to "which key is this session's
   *   pump filed under" — `SessionStore.sessionKeyOf` in production.
   */
  constructor(registry: SessionPumpRegistry, sessionKeyOf: (sessionId: string) => string) {
    this.registry = registry;
    this.sessionKeyOf = sessionKeyOf;
  }

  /**
   * Should this message run on a held process?
   *
   * The flag is read HERE, immediately before the pump is acquired, which is
   * what makes the opt-in per-session rather than per-host: a session that
   * already holds a process keeps the path it started on, whatever the setting
   * says now. See the module doc for what that means in each direction.
   *
   * Asked by every route that could put a process under a session — a turn
   * ({@link dispatch}), a stage ({@link stage}), and the runtime's per-session
   * answers for steering and staging — so all four agree by construction rather
   * than by four copies of the same condition.
   *
   * @param sessionId - The session about to dispatch
   */
  shouldDispatch(sessionId: string): boolean {
    // Not resolved here: `registry.peek` already resolves through the SAME
    // `sessionKeyOf`, so a second resolution here would only be redundant.
    if (this.registry.peek(sessionId) !== undefined) return true;
    return isPersistentSessionEnabled();
  }

  /**
   * Forget a session's wiring. Called when its process is dropped for good, so
   * the next message builds a fresh pump rather than dispatching into a spent
   * one.
   *
   * The resolution below is belt-and-braces, not load-bearing: every OTHER
   * reader of {@link bundles} already checks `registry.peek(key) ===
   * bundle.pump` before trusting a lingering entry (`acquire`, `steer`,
   * `stage`, `settleOpenTurn`), so a call here that missed its resolve (an
   * unresolved raw id landing on nothing, or the wrong stale entry) would at
   * worst leave a dead `SessionBundle` sitting in the map under an id nothing
   * will ever ask for again — a harmless space leak, never a wrong answer.
   *
   * @param sessionId - The session going away, in any id it answers to
   */
  forget(sessionId: string): void {
    this.bundles.delete(this.sessionKeyOf(sessionId));
  }

  /**
   * The live query of a turn that is still BOOTING on this session, or
   * `undefined` when none is.
   *
   * The runtime's `interruptQuery` reaches for this only after the ordinary Stop
   * path (`session.activeQuery`) found nothing, so a Stop pressed while a cold
   * session's first turn is still launching can still reach the process the pump
   * holds — the `running` edge that would arm `activeQuery` has not fired yet
   * (DOR-1191). Returns nothing for a merely-warm idle session: `booting` is
   * only true while a dispatch is opening a turn, so a healthy warm process is
   * never handed out to be interrupted.
   *
   * @param sessionId - The session a Stop is trying to reach, in any id it
   *   answers to
   */
  bootingQuery(sessionId: string): Query | undefined {
    const bundle = this.bundles.get(this.sessionKeyOf(sessionId));
    if (bundle === undefined || !bundle.booting) return undefined;
    return bundle.live;
  }

  /**
   * Run one message as a turn on this session's held process.
   *
   * @param args - The session, its message, and the runtime's ports. `sessionId`
   *   is the id THIS call was asked with — only a hint after the session's
   *   first rename — and is resolved to {@link key} before it ever reaches
   *   {@link bundles} or the registry; it is kept as-is everywhere else
   *   (logging, the launch resolution, the events this turn yields) because
   *   those are cosmetic to the id a caller happened to use, not the identity
   *   of the process being dispatched to.
   */
  async *dispatch(args: PersistentDispatchArgs): AsyncGenerator<StreamEvent> {
    const { sessionId, content, session, opts, messageOpts } = args;
    const key = this.sessionKeyOf(sessionId);
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

    let bundle = this.acquire(key, session, opts);
    // Nothing pinned to the live process may be stale by the time the turn
    // opens. A pin the SDK cannot set live replaces the process outright; the
    // four it can are awaited, never fired blind (`launch-live-settings.ts`).
    const reuse = decideProcessReuse(bundle.fingerprint, plan.fingerprint);
    if (reuse.action === 'replace') {
      logger.info('[persistent-dispatch] replacing a warm process', {
        session: sessionId,
        reason: reuse.reason,
      });
      await this.replaceProcess(key);
      bundle = this.acquire(key, session, opts);
    } else if (reuse.action === 'adjust') {
      const control = bundle.pump.controlQuery;
      if (control === undefined) {
        // The process went away between the comparison and here. Nothing to
        // adjust and nothing stale to ride: the dispatch below relaunches.
        bundle.live = undefined;
        bundle.fingerprint = undefined;
      } else {
        try {
          // What the process HOLDS, which is not always what was wanted: a
          // setter that went unanswered inside its bound leaves its pin where it
          // was, and the next dispatch has to see that (DOR-1301).
          bundle.fingerprint = await reuse.apply(control);
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
    // A turn is booting from here until its window opens — the span in which the
    // pump is warming and `session.activeQuery` is not yet armed, so Stop reaches
    // the turn only through `bootingQuery` (DOR-1191). Cleared once the window is
    // open (the `running` edge has armed `activeQuery`) or the dispatch is
    // refused, in both cases through the `finally`.
    bundle.booting = true;
    try {
      window = await bundle.recovery.dispatch(
        [{ content: plan.enrichedContent, messageId: messageOpts?.messageId ?? randomUUID() }],
        effectiveCwd
      );
    } catch (err) {
      yield* this.explainRefusedDispatch(sessionId, err);
      return;
    } finally {
      bundle.booting = false;
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
   * End a turn this session has left open, so the turn about to replace it does
   * not inherit it (DOR-1295).
   *
   * The window is abandoned exactly as {@link SessionTurnWindows.dispatch}'s
   * backstop abandons one — a synthetic error `result`, one `turn_end`, the
   * pump's turn ended — only EARLIER: called ahead of the successor's
   * `turn_start`, so the abandoned turn's terminal cannot land inside the
   * successor's window.
   *
   * A bundle the registry no longer backs is treated as holding nothing, for
   * the same reason {@link steer} does: a reaped pump is spent and refuses
   * everything asked of it, and there is no window under it to settle anyway.
   *
   * A window that is merely waiting to see whether a steer got a turn of its
   * own (DOR-1314) is settled here too, but on the real `result` it is holding
   * rather than on a synthetic error — and it answers `false`, because that
   * turn finished. The caller logs a `true` as "ended a turn that never
   * finished", and that sentence would not be true of it.
   *
   * @param sessionId - The session about to open a turn, in any id it answers to
   * @returns True when a turn that never finished had to be abandoned
   */
  settleOpenTurn(sessionId: string): boolean {
    const key = this.sessionKeyOf(sessionId);
    const bundle = this.bundles.get(key);
    if (bundle === undefined || this.registry.peek(key) !== bundle.pump) return false;
    return bundle.windows.abandonOpenWindow();
  }

  /**
   * Steer a message into a session's OPEN turn — the claude-code half of P4's
   * `deliverIntoTurn(mode: 'steer')` (spec §2.3, task 4.1).
   *
   * A steer does not open a turn: it pushes into the held input stream of the
   * one already running, reaching the CLI's own queue so the message is
   * delivered within the live turn. So this returns a RECEIPT — the resulting
   * events surface on that turn's already-running stream (`streamTurnWindow`),
   * which another consumer is already draining, and a second generator here
   * would be two feeds fighting over one turn.
   *
   * `content` is the person's words, PRISTINE. Any `additionalContext` is
   * rendered out of band and prepended exactly as a normal turn's is
   * (`launch-resolver.ts`), so the transcript shows the person's text and the
   * context rides its own strippable tags (ADR-0273).
   *
   * **Never throws for an ordinary refusal**, per the `deliverIntoTurn` contract.
   * Two seams make that non-trivial:
   *
   * - **A spent pump.** The registry idle-reaps and warm-ceiling-replaces pumps
   *   WITHOUT telling this class (see {@link acquire}), and a reaped pump throws
   *   for everything asked of it (`assertUsable`). So a lingering bundle is used
   *   only when the registry still points at its pump — the same identity check
   *   `dispatch` makes through {@link acquire} — and otherwise treated as no live
   *   process. That keeps a reaped-bundle steer a `no-open-turn` receipt rather
   *   than a throw.
   * - **The close gap.** The gate is WINDOW openness, not the pump's `'running'`
   *   state, because a window is cleared synchronously on its `result` while the
   *   pump only leaves `RUNNING` after the closing accounting fetch — up to
   *   `WINDOW_USAGE_TIMEOUT_MS` (~8s) later. In that gap the pump is still
   *   `'running'` with NO open window; pushing then would open a SECOND turn
   *   instead of joining one and still report `delivered`. So the window is
   *   TAGGED first (which both checks it is open and correlates the id): no
   *   window means `no-open-turn` and nothing is pushed. Only once a window has
   *   accepted the id does the push follow, in the same synchronous beat so no
   *   `result` can slip between them.
   *
   * @param sessionId - The session to steer; either id a caller might hold,
   *   resolved to the one key this session's bundle is filed under
   * @param content - The user's text, pristine
   * @param opts - The correlation id and the neutral context bag
   * @returns Whether the steer reached the process, and why not when it did not
   */
  steer(sessionId: string, content: string, opts: DeliverIntoTurnOpts): RuntimeDeliveryResult {
    const key = this.sessionKeyOf(sessionId);
    const bundle = this.bundles.get(key);
    // No wiring, or a bundle the registry no longer backs (an idle reap or a
    // warm-ceiling reclaim this class was never told about): no live process to
    // join, and touching a spent pump would throw the must-not-throw contract.
    if (bundle === undefined || this.registry.peek(key) !== bundle.pump) {
      return { delivered: false, reason: 'no-open-turn' };
    }
    // Tag the OPEN window first — this both proves a window is open (the gate)
    // and teaches it this id so the coalesced `result` still closes it as one
    // turn. No window means the turn closed under us (the pump may still read
    // `'running'` in the ~8s accounting gap): report it, push nothing.
    if (!bundle.windows.steerOpenWindow(opts.messageId)) {
      return { delivered: false, reason: 'no-open-turn' };
    }
    const enriched = enrichDeliveredContent(content, opts.additionalContext);
    const outcome = bundle.pump.steer(enriched, opts.messageId);
    // A push that fails after the tag (the amnesiac stream-closed race) leaves
    // the id on the window with nothing sent under it — harmless: the window
    // still closes on its own `result` (or the crash that abandoned the stream),
    // and an id no `result` ever names correlates nothing.
    if (outcome !== 'delivered') return { delivered: false, reason: outcome };
    return { delivered: true };
  }

  /**
   * Stage a message onto a session's transcript WITHOUT opening a turn — the
   * claude-code half of P4's `deliverIntoTurn(mode: 'stage')` (spec §2.5, task
   * 4.2).
   *
   * Two things make this different from {@link steer}, and both are the same
   * difference: a stage needs no open turn.
   *
   * - **A warm or running session** already holds a live stream, so the staged
   *   message is appended to it directly ({@link SessionPump.stage}, `shouldQuery:
   *   false`). No window opens and no `result` is expected, so — unlike a steer —
   *   there is no window to tag and nothing to correlate: the receipt is the whole
   *   of it. Legal during the owner's own running turn too; the caller's write
   *   authorization gate has already settled who may write.
   * - **A COLD session that has OPTED IN warms first**, because the message has
   *   to REACH a transcript and a cold session has none live. The process is
   *   booted under the resolved plan — the same launch the turn path builds — and
   *   then the message is appended. This is the one case where staging starts a
   *   process; it still opens no turn.
   * - **A COLD session that has NOT opted in is refused**, `unsupported`, before
   *   anything is acquired or launched. {@link shouldDispatch} is the same
   *   question a turn asks, so the module's one promise holds without exception:
   *   a process starts only where the operator turned the setting on. Staging did
   *   not ask it, so "Add context" quietly booted an agent AND moved the session
   *   onto this path for good, since a registry entry makes every later message
   *   dispatch here (DOR-1307). The server reads the same answer through
   *   `canStageSession` and folds the words into the next turn instead, so
   *   reaching this refusal at all means the server asked when it should not
   *   have.
   *
   * Unlike {@link steer}, this takes the `session` and the sender/message options,
   * because warming a cold session needs the launch plan that a bare
   * {@link DeliverIntoTurnOpts} cannot carry. On the warm fast path they go
   * unused — there is nothing to launch.
   *
   * **Never throws for an ordinary refusal**, per the `deliverIntoTurn` contract:
   * a boundary a warm cwd would fail, a stream that closed under a warm process,
   * a launch that could not boot — all come back as `{ delivered: false }`.
   *
   * @param sessionId - The session to stage onto; either id a caller might
   *   hold, resolved to the one key this session's bundle is filed under
   * @param content - The person's text, pristine; context rides `opts`
   * @param opts - The mode, correlation id, and the neutral context bag
   * @param session - The session record, for a cold warm-up
   * @param senderOpts - The runtime ports a launch needs
   * @param messageOpts - Per-turn options a launch reads (cwd, settings)
   * @returns Whether the staged message reached the process, and why not when not
   */
  async stage(
    sessionId: string,
    content: string,
    opts: DeliverIntoTurnOpts,
    session: AgentSession,
    senderOpts: MessageSenderOpts,
    messageOpts?: MessageOpts
  ): Promise<RuntimeDeliveryResult> {
    const key = this.sessionKeyOf(sessionId);
    const enriched = enrichDeliveredContent(content, opts.additionalContext);
    const existing = this.bundles.get(key);
    // A bundle the registry still backs holds a live (warm or running) process.
    // A bundle it no longer backs — an idle reap or a warm-ceiling reclaim this
    // class was never told about — is as good as cold: touching its spent pump
    // would throw, so it falls through to the cold path and builds a fresh one.
    const live = existing !== undefined && this.registry.peek(key) === existing.pump;

    let bundle: SessionBundle;
    if (live) {
      bundle = existing;
    } else {
      // Nothing below this line may run for a session that would not have been
      // dispatched here anyway: `acquire` registers the session and `warm()`
      // boots a real CLI subprocess, and both are the operator's decision, not a
      // side effect of adding a note (DOR-1307).
      if (!this.shouldDispatch(key)) {
        return { delivered: false, reason: 'unsupported' };
      }
      const effectiveCwd = resolveEffectiveCwd(senderOpts, messageOpts);
      try {
        // Warming boots a process in this cwd, so the boundary that gates the
        // turn path gates this too — a staged note is not a reason to start a
        // subprocess somewhere the person is not allowed to run one.
        await validateDispatchBoundary(effectiveCwd);
      } catch {
        logger.warn('[persistent-dispatch] boundary violation on stage', {
          session: sessionId,
          effectiveCwd,
        });
        return { delivered: false };
      }
      const resolved = await resolveLaunch({
        sessionId,
        content,
        session,
        opts: senderOpts,
        ...(messageOpts !== undefined ? { messageOpts } : {}),
        effectiveCwd,
      });
      const plan: PumpLaunchPlan = {
        effectiveCwd,
        // `enrichedContent` is unused on the stage path: `warm()` boots with the
        // IDLE prompt (no first message), and the staged text arrives separately
        // via the `shouldQuery: false` append below — not through the launch. The
        // plan is built whole anyway because `warm()` consumes the rest of it
        // (`sdkOptions`, `fingerprint`) through the shared launcher.
        enrichedContent: resolved.enrichedContent,
        meshAgentId: resolved.meshAgentId,
        statusEvents: resolved.statusEvents,
        sdkOptions: resolved.sdkOptions,
        fingerprint: captureLaunchFingerprint(resolved.launch),
      };
      bundle = this.acquire(key, session, senderOpts);
      bundle.plan = plan;
    }

    try {
      // A no-op when the process is already warm or running; awaits an in-flight
      // launch when it is warming; boots one from cold. Either way, this returns
      // only once there is a live stream to append to (or it threw trying).
      await bundle.pump.warm();
    } catch (err) {
      logger.warn('[persistent-dispatch] failed to warm a session for staging', {
        session: sessionId,
        err,
      });
      return { delivered: false, reason: 'stream-closed' };
    }
    const outcome = bundle.pump.stage(enriched, opts.messageId);
    // `no-process` after a resolved `warm()` means the process went away between
    // the two — the same amnesiac race as a `stream-closed`, reported the same
    // way so the caller degrades rather than believing a dropped message landed.
    if (outcome !== 'delivered') return { delivered: false, reason: 'stream-closed' };
    // The staged message opens no window, but the turn it merges into may be
    // answered under ITS id — and a `result` naming an id the windower never
    // heard of is what stranded a turn window in DOR-1294.
    bundle.windows.noteStagedMessage(opts.messageId);
    return { delivered: true };
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
   *
   * @param key - The resolved map key this session's bundle lives (or will
   *   live) under — every public method resolves the caller's id through
   *   {@link sessionKeyOf} before calling this, so this private half never
   *   resolves twice
   * @param session - The session record the bundle is wired for
   * @param opts - The runtime ports the launcher and the interactive gate need
   */
  private acquire(key: string, session: AgentSession, opts: MessageSenderOpts): SessionBundle {
    const existing = this.bundles.get(key);
    // Held to the REGISTRY's answer, not to the map's, because the registry
    // drops pumps this class never hears about: the idle timer reaps one after
    // five quiet minutes, and a warm-ceiling reclaim takes the least recently
    // used. A reaped pump is spent — it refuses everything asked of it — so a
    // bundle still pointing at one would turn the next message into an illegal
    // transition instead of a fresh launch. Identity, not presence: a pump the
    // registry replaced is as stale as one it dropped.
    if (existing !== undefined && this.registry.peek(key) === existing.pump) return existing;

    // `existing !== undefined` here means this class HELD a bundle for this
    // session and the registry no longer backs it with the same pump — an
    // idle reap or a warm-ceiling reclaim it was never told about (see the
    // comment above). That is a genuine relaunch, not a first-time cold
    // start, and it used to be invisible below `debug`: a session mid-flow
    // would silently pay for a fresh process boot with no line in the log
    // explaining why (DOR-1323, flag-on run L-11). One line, not per-turn —
    // this fires only on the transition, never on the (far more common)
    // warm reuse a line above returns early on.
    if (existing !== undefined) {
      logger.info('[persistent-dispatch] relaunching after the registry reaped this session', {
        session: key,
      });
    }

    // Definitely-assigned three lines down. Nothing can observe the gap: the
    // pump boots nothing until it is dispatched to, which cannot happen before
    // this function returns.
    const bundle = {
      live: undefined,
      fingerprint: undefined,
      plan: undefined,
      booting: false,
    } as unknown as SessionBundle;

    bundle.pump = this.registry.acquire(key, {
      maxWarmSessions: SESSIONS.MAX_WARM_SESSIONS,
      warmIdleMs: SESSIONS.WARM_IDLE_MS,
      launch: createPumpLauncher(
        session,
        opts,
        () => {
          const plan = bundle.plan;
          if (plan === undefined) {
            // A launch with no plan would boot a process with no options at
            // all. Nothing can reach here — the pump only launches from inside
            // a dispatch, and `dispatch` parks the plan first — so this is a
            // caller-bug guard, not a fallback.
            throw new PumpRefusedError(
              'process-gone',
              `session ${key} tried to launch with no resolved plan`
            );
          }
          return plan;
        },
        (live, fingerprint) => {
          bundle.live = live;
          bundle.fingerprint = fingerprint;
        }
      ),
      onMessage: (message) => bundle.windows.onMessage(message),
      onCrash: (crash) => {
        // The process is gone, so nothing may ride it. `session.activeQuery` is
        // already clear: `noteProcessGone` moves the pump to `crashed` before it
        // announces the crash, and that transition disarms it above.
        bundle.live = undefined;
        bundle.fingerprint = undefined;
        bundle.recovery.handleCrash(crash);
      },
      onStateChange: (change) => {
        // `session.activeQuery` means "a turn is in flight", and on the resume
        // path it is cleared in every turn's `finally`. A pump has no such
        // frame, so the pump's own `running` edge is what arms and disarms it —
        // one rule, driven by the state machine, so every exit is covered: the
        // turn ending, the idle reap, a warm-ceiling reclaim, an eviction, a
        // crash and shutdown, including the three the registry takes without
        // telling this class.
        //
        // Leaving it armed between turns is not a cosmetic lie. `interruptQuery`
        // escalates to `close()` when `interrupt()` rejects, so a Stop pressed
        // on a warm IDLE session would answer "interrupted", destroy a perfectly
        // healthy subprocess, and leave the session reporting `crashed`.
        if (change.to === 'running') {
          session.activeQuery = bundle.live;
        } else if (session.activeQuery !== undefined) {
          // Preserved as `lastQuery` exactly as the resume path preserves it, so
          // post-turn control calls (`reloadPlugins`, the model probe) still
          // have something to talk to.
          session.lastQuery = session.activeQuery;
          session.activeQuery = undefined;
        }
        bundle.recovery.noteStateChange(change);
      },
      // The map's raw SIZE was the wrong answer, for the same reason it is
      // wrong in the projector: an entry CAN strand, and a stranded one would
      // decline every reap and refuse every message into this session forever.
      // {@link isWaitingOnPerson} bounds it by the wait this session actually
      // allows, so all three answers to "is somebody still expected back"
      // agree (spec `ask-parks-on-timeout`).
      hasPendingInteraction: () => isWaitingOnPerson(session, Date.now()),
    });

    bundle.windows = new SessionTurnWindows({
      sessionId: key,
      pump: bundle.pump,
      onWindowOpen: (window) => {
        // A window nobody dispatched has no consumer here. Its channel would
        // otherwise buffer a whole synthetic turn that nothing ever reads.
        if (window.origin === 'runtime') void drainUnprojected(key, window);
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
      sessionId: key,
      pump: bundle.pump,
      windows: bundle.windows,
    });

    this.bundles.set(key, bundle);
    return bundle;
  }

  /**
   * Close this session's process and forget its wiring, so the next dispatch
   * launches a fresh one under the values it resolved.
   *
   * `evict` rather than `reap`: a reap is polite and may decline, and a pin that
   * moved is not a request. Safe where a reap would not be, because eviction
   * tears the process down unconditionally and {@link forget} drops the bundle
   * with it — so nothing is left holding the old process, and the dispatch that
   * called this builds fresh wiring for a fresh launch. It is called from
   * {@link dispatch} before any window is opened, which is the only moment this
   * session has no turn of its own in flight.
   *
   * @param key - The resolved map key, exactly as {@link acquire} takes
   */
  private async replaceProcess(key: string): Promise<void> {
    await this.registry.evict(key);
    this.forget(key);
  }
}

/**
 * Prepend a delivered message's context bag to its pristine content, the SAME
 * way a normal turn does it (`launch-resolver.ts`). Shared by {@link
 * PersistentDispatch.steer} and {@link PersistentDispatch.stage}: both carry the
 * person's words pristine and any context out of band, so both enrich the same
 * way.
 *
 * The person's `content` is never mutated: the render produces a separate
 * enriched string, the context blocks carry their own tags, and the adapter
 * strips those on render so injected context never shows as user-authored text
 * (ADR-0273). No context is the identity case — the pristine content, unchanged.
 *
 * @param content - The user's text, pristine
 * @param additionalContext - The neutral context bag, or undefined
 */
function enrichDeliveredContent(content: string, additionalContext?: AdditionalContext): string {
  const contextBlocks = (additionalContext ?? []).map(renderContextEntry).filter(Boolean);
  if (contextBlocks.length === 0) return content;
  return `${contextBlocks.join('\n\n')}\n\n${content}`;
}

/**
 * Read a window nothing will project, so its buffer empties and its close can
 * settle. Never yields the messages anywhere: see the module doc.
 */
async function drainUnprojected(sessionId: string, window: TurnWindow): Promise<void> {
  const census: Record<string, number> = {};
  let dropped = 0;
  let content = 0;
  try {
    for await (const message of window.messages) {
      dropped += 1;
      census[message.type] = (census[message.type] ?? 0) + 1;
      if (carriesContent(message)) content += 1;
    }
  } catch (err) {
    logger.debug('[persistent-dispatch] a runtime window failed while draining', {
      sessionId,
      err,
    });
  }
  // The two cases are genuinely different and must not read alike. A window
  // holding only a `result` and a `system` line is bookkeeping the CLI
  // volunteered — routine, and a warning about it is noise that trains people
  // to ignore the log. A window holding model speech is words a person was owed
  // and never saw, which is the DOR-1314 loss, and it says so at the level that
  // gets read.
  if (content === 0) {
    logger.debug('[persistent-dispatch] drained a content-free turn nobody asked for', {
      sessionId,
      dropped,
      census,
    });
    return;
  }
  logger.error('[persistent-dispatch] dropped model output nobody could project', {
    sessionId,
    dropped,
    content,
    census,
  });
}

/**
 * Whether an SDK message carries something a person would have read — model
 * speech or tool traffic — as opposed to the process's own bookkeeping.
 *
 * Deliberately generous: anything that is not a `result` or a `system` line
 * counts. An over-count costs one log line at the wrong level; an under-count
 * would report data loss as routine, which is the failure this exists to
 * prevent.
 *
 * @param message - One message drained from a window nothing will project
 */
function carriesContent(message: SDKMessage): boolean {
  return message.type !== 'result' && message.type !== 'system';
}
