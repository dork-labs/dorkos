/**
 * The production {@link RoomTurnRunner}: a room post becomes a real agent turn.
 *
 * It is one file, separate from `room-trigger.ts`, so the cascade rules stay
 * testable without a runtime and this — the part that needs sessions, the
 * runtime registry and a lock — stays the only place that knows about them.
 *
 * Two decisions worth reading before changing anything here:
 *
 * - **The turn runs through {@link dispatchMessage}, not the runtime directly.**
 *   Going straight to `runtime.sendMessage` would be shorter and would make the
 *   agent's work invisible: nothing would feed the per-session projector, so
 *   opening that session in the cockpit would show an empty transcript while
 *   the agent was mid-answer. Everything a room triggers is a normal session
 *   turn, visible on `GET /api/sessions/:id/events` like any other (ADR-0264).
 *
 * - **The reply is read off the projector, not the generator.** The dispatcher
 *   detaches the turn deliberately (the HTTP 202 must not wait on a model), so
 *   the only way to learn what the agent said is to subscribe to the same
 *   stream a client would. Subscribing from the cursor taken BEFORE the trigger
 *   is what makes that gap-free.
 *
 * - **`content` is the message, and nothing else.** Where the turn is happening
 *   rides the `additionalContext` bag as a `room_context` entry (ADR-0273), so
 *   the visible user turn holds exactly the words a person typed and every
 *   runtime gets the same structured framing.
 *
 * - **Every way a turn can produce no answer is reported, not logged.** A busy
 *   session, a failed turn and a turn that outruns the room's patience all used
 *   to return the same `null` the agent returns when it simply has nothing to
 *   say, so the room could not tell them apart and said nothing about any of
 *   them. Each now comes back named, and `room-trigger.ts` gives the room its
 *   words (DOR-621, ADR 260726-170127).
 *
 * @module server/services/rooms/room-turn-runner
 */
import { runOriginalRoomTurn } from './room-turn-original-run.js';
import type { RoomTurnRunView } from './turn/room-turn-run-contracts.js';
const originalRoomTurnRunViews = new WeakMap<object, RoomTurnRunView>();
/** Resolve only a factory-private original run key before any caller callbacks, sessions, dispatch or native launch. */
export function readOriginalRoomTurnRunView(key: object): RoomTurnRunView {
  const view = roomReplyApply(roomReplyGet, originalRoomTurnRunViews, [key]) as
    RoomTurnRunView | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}

import { DocChannelNotFoundError } from '../canvas/doc-channel/authorization/authorization-data.js';
import { collectReply as collectOriginalRoomReply } from './room-turn-reply-collector.js';

import type { RoomTurnReplyView } from './turn/room-reply-collector-contracts.js';
const roomReplyFreeze = Object.freeze;
const roomReplyGet = WeakMap.prototype.get;
const roomReplySet = WeakMap.prototype.set;
const roomReplyApply = Reflect.apply;
const originalRoomReplyKey = roomReplyFreeze({});
const originalRoomReplyViews = new WeakMap<object, RoomTurnReplyView>();
/** Resolve only the original module-private reply selector before timers, callbacks, stream reads or canvas effects. */
export function readOriginalRoomTurnReplyView(key: object): RoomTurnReplyView {
  const view = roomReplyApply(roomReplyGet, originalRoomReplyViews, [key]) as
    RoomTurnReplyView | undefined;
  if (!view) throw new DocChannelNotFoundError();
  return view;
}
roomReplyApply(roomReplySet, originalRoomReplyViews, [
  originalRoomReplyKey,
  roomReplyFreeze({
    get messageBoundary() {
      return MESSAGE_BOUNDARY;
    },
    get waitingKinds() {
      return WAITING_KINDS;
    },
  }),
]);
type OriginalReplyArgs =
  Parameters<typeof collectOriginalRoomReply> extends [object, ...infer Args] ? Args : never;
/** Start the original synchronous collector with the root-private selector and exactly the supplied arguments. */
const collectReply = (...args: OriginalReplyArgs): ReturnType<typeof collectOriginalRoomReply> =>
  collectOriginalRoomReply(originalRoomReplyKey, ...args);

import { createRoomTurnStopState } from './turn/room-turn-stop-state.js';
import { WAITING_KINDS } from './turn-guards/waiting-kinds.js';

import path from 'node:path';
import type {
  AgentRuntime,
  TurnPermissionBound,
  TurnPermissionCeiling,
} from '@dorkos/shared/agent-runtime';
import type { Room } from '@dorkos/shared/room-schemas';
import { RoomContextDataSchema, type RoomContextData } from '@dorkos/shared/additional-context';
import type { InterruptReceipt } from '@dorkos/shared/types';
import { logger } from '../../lib/logger.js';
import { ROOMS } from '../../config/constants.js';

import { tryGetRoomRepoService } from './index.js';
import { runtimeRegistry } from '../core/runtime-registry.js';

// The one VALUE this module takes from the port, so it comes straight from the
// port rather than through `room-trigger.js`'s type re-export below: a value
// import there would load the dispatcher to raise a refusal it hands back to it.

import { resolveTurnRuntimeType } from '../runtimes/shared/resolve-agent-runtime-type.js';

import {
  resolveUnattendedSessionDefaults,
  resolveUnattendedPermissionMode,
} from '../session/resolution/resolve-session-defaults.js';

import { type DispatchMessageOpts } from '../session/message-dispatcher.js';
import {
  readOriginalRoomDispatchRequest,
  readOriginalRoomRequestCurrent,
  readOriginalRoomSessionOwner,
} from './service/room-core.js';

import type {
  RoomTurnRequest,
  RoomTurnResult,
  RoomTurnRunner,
  RoomTurnWaiting,
} from './room-trigger.js';

declare const originalRunnerBrand: unique symbol;
export interface OriginalSessionRoomRunner {
  readonly [originalRunnerBrand]: true;
}
const originalRunners = new WeakMap<
  RoomTurnRunner,
  {
    identity: OriginalSessionRoomRunner;
    run: RoomTurnRunner['run'];
    interrupt: RoomTurnRunner['interrupt'];
  }
>();
const originalPlacedContexts = new WeakMap<RoomTurnRunner, Map<string, RoomTurnRequest>>();
/** Completion DATA only: neither a request nor a runtime/producer permission. */
export type OriginalRoomRunnerCompletion =
  | Readonly<{ kind: 'returned'; result: RoomTurnResult }>
  | Readonly<{ kind: 'threw'; cause: unknown }>;
/** Immutable computed preference/posture DATA; omission is preserved. */
/** Detached fixed-field DATA; observers cannot mutate the original dispatch bound. */
function copyOriginalRoomPermissionCeiling(ceiling: TurnPermissionCeiling): TurnPermissionCeiling {
  const copyBound = (bound: TurnPermissionBound): TurnPermissionBound =>
    typeof bound === 'string'
      ? bound
      : Object.freeze({
          asks: bound.asks,
          reach: bound.reach,
          ...(bound.auto === true ? { auto: true as const } : {}),
        });
  if (typeof ceiling === 'string' || 'asks' in ceiling) return copyBound(ceiling);
  return Object.freeze(ceiling.map(copyBound));
}
export interface OriginalRoomRunnerComputedDefaults {
  readonly whenBusy: DispatchMessageOpts['whenBusy'];
  readonly permissionCeiling?: DispatchMessageOpts['permissionCeiling'];
  readonly settings: Readonly<Awaited<ReturnType<typeof resolveUnattendedSessionDefaults>>>;
  readonly newSessionPermissionMode?: ReturnType<typeof resolveUnattendedPermissionMode>;
}
export interface OriginalRoomRunnerObservation {
  readonly completion: Promise<OriginalRoomRunnerCompletion>;
  readonly computedDefaults: OriginalRoomRunnerComputedDefaults | undefined;
}
const originalCompletions = new WeakMap<
  RoomTurnRunner,
  {
    request: RoomTurnRequest;
    observation: OriginalRoomRunnerObservation;
    defaults: { value?: OriginalRoomRunnerComputedDefaults };
  }
>();
/**
 * Acquire one read-only completion while this exact original request is current.
 * Only the latest constructor run is retained; completion retires this lookup.
 * A saved promise carries actual result DATA, never reusable native authority.
 */
export function readOriginalRoomRunnerObservation(
  runner: RoomTurnRunner,
  entryId: string
): OriginalRoomRunnerObservation | undefined {
  const current = originalCompletions.get(runner);
  if (
    !current ||
    current.request.entry.id !== entryId ||
    !readOriginalSessionRoomRunner(runner) ||
    !readOriginalRoomDispatchRequest(current.request, runner) ||
    !readOriginalRoomRequestCurrent(current.request, runner)
  ) {
    return undefined;
  }
  return originalCompletions.get(runner) === current &&
    readOriginalSessionRoomRunner(runner) &&
    readOriginalRoomDispatchRequest(current.request, runner) &&
    readOriginalRoomRequestCurrent(current.request, runner)
    ? current.observation
    : undefined;
}

/** Historical placement DATA during the original conventions read; never a launch issuer. */
export function readOriginalRoomRunnerPlacedContext(
  runner: RoomTurnRunner,
  sessionId: string
): RoomContextData | undefined {
  const requests = originalPlacedContexts.get(runner);
  const request = requests?.get(sessionId);
  if (
    !request ||
    !readOriginalSessionRoomRunner(runner) ||
    !readOriginalRoomDispatchRequest(request, runner) ||
    !readOriginalRoomRequestCurrent(request, runner)
  )
    return undefined;
  const context = RoomContextDataSchema.parse(request.roomContext);
  return requests?.get(sessionId) === request &&
    readOriginalSessionRoomRunner(runner) &&
    readOriginalRoomRequestCurrent(request, runner)
    ? context
    : undefined;
}
const originalLaunches = new WeakMap<
  RoomTurnRequest,
  {
    runner: RoomTurnRunner;
    sessionId: string;
    prepare: NonNullable<RoomTurnRequest['prepareLaunch']>;
    active: boolean;
  }
>();
const originalPreparations = new WeakMap<
  RoomTurnRequest,
  {
    runner: RoomTurnRunner;
    sessionId: string;
    prepare: RoomTurnRequest['prepareLaunch'];
  }
>();
/** Lookup only: completion is recorded solely by this Runner's actual required preparation. */
export function readOriginalRoomRunnerPreparation(
  request: RoomTurnRequest,
  runner: RoomTurnRunner,
  sessionId: string
): boolean {
  const completed = originalPreparations.get(request);
  return (
    !!completed &&
    completed.runner === runner &&
    completed.sessionId === sessionId &&
    !!readOriginalSessionRoomRunner(runner) &&
    Object.getOwnPropertyDescriptor(request, 'prepareLaunch')?.value === completed.prepare &&
    !!readOriginalRoomDispatchRequest(request, runner) &&
    !!readOriginalRoomRequestCurrent(request, runner) &&
    readOriginalRoomSessionOwner(request, runner, sessionId) &&
    originalPreparations.get(request) === completed
  );
}
/** Lookup-only actual awaited launch DATA. No caller can register a request or session. */
export function readOriginalRoomRunnerLaunch(
  request: RoomTurnRequest
): Readonly<{ runner: RoomTurnRunner; sessionId: string }> | undefined {
  const launch = originalLaunches.get(request);
  if (
    !launch?.active ||
    !readOriginalSessionRoomRunner(launch.runner) ||
    Object.getOwnPropertyDescriptor(request, 'prepareLaunch')?.value !== launch.prepare ||
    !readOriginalRoomRequestCurrent(request, launch.runner) ||
    originalLaunches.get(request) !== launch ||
    !launch.active
  )
    return undefined;
  return Object.freeze({ runner: launch.runner, sessionId: launch.sessionId });
}
/** Fixed constructor membership read. No caller can register or supply an origin. */
export function readOriginalSessionRoomRunner(
  runner: RoomTurnRunner
): OriginalSessionRoomRunner | undefined {
  const state = originalRunners.get(runner);
  return state &&
    Object.getOwnPropertyDescriptor(runner, 'run')?.value === state.run &&
    Object.getOwnPropertyDescriptor(runner, 'interrupt')?.value === state.interrupt
    ? state.identity
    : undefined;
}

/**
 * Lock identity every room-triggered turn takes — see {@link ROOMS.CLIENT_ID},
 * which owns it because the message dispatcher has to recognise it too.
 */
const ROOM_CLIENT_ID = ROOMS.CLIENT_ID;

/**
 * The two bounds on how long a room pays attention to one turn.
 *
 * **`waitMs` bounds the WAIT, not the turn.** The turn itself is never
 * cancelled: it keeps running and keeps streaming to its own session, and when
 * it finally closes its answer is posted into the room with the delay said out
 * loud (the late-answer note in `notices/notice-copy.ts`). An earlier revision dropped
 * it at this deadline on the theory that a very late reply is worse than none —
 * which gets the trade backwards. Silence is the worse failure, and a person who
 * waited ten minutes for an answer deserves it more than the room deserves to be
 * tidy.
 *
 * **`ceilingMs` is the hard stop on the subscription.** The stall watchdog
 * inside the dispatched turn already ends any turn whose runtime goes quiet, so
 * reaching this means a turn producing events and never closing. The room stops
 * listening and says the turn failed, which is true, rather than holding one
 * live subscription per trigger forever.
 *
 * Both come from user config (`rooms.replyWaitMinutes`,
 * `rooms.lateReplyCeilingMinutes`) and both are read PER TURN, so a change takes
 * effect on the next message rather than the next restart — the same contract
 * `maxAgentDepth` and the spend caps keep.
 *
 * **Neither number is sourced.** `meta/agent-etiquette.md` §9: no vendor
 * publishes a defensible figure for how long a person will wait on an agent and
 * no study establishes one, so these are set by using the product. They are
 * meant to be tuned, and the honest thing is to say so rather than to invent a
 * citation later.
 */
export interface RoomTurnRunnerOptions {
  /** Passive completion DATA, synchronously captured by this original constructor. */
  observeRun?: (entryId: string, observation: OriginalRoomRunnerObservation) => void;
  /** Passive scalar observation at the original pre-dispatch boundary. */
  observeBeforeDispatch?: (entryId: string) => void;
  /** How long the room waits for the answer before continuing without it. */
  waitMs?: () => number;
  /** How long the late collector keeps listening before giving the turn up. */
  ceilingMs?: () => number;
  /**
   * How long a prompt may stand before the room mentions it
   * ({@link WAITING_NOTICE_GRACE_MS}).
   *
   * Unlike its two siblings this is NOT user config — it is here so a test can
   * shorten it without shortening the wall clock, and it has no reader in
   * production.
   */
  waitingGraceMs?: () => number;
  /**
   * This room's own conventions, composed for one turn — spec `project-rooms`
   * §3.3. `null` for a room with no files, which is every room today unless the
   * operator gave one a repo.
   *
   * Injected so a test can hand the runner a block without standing up a git
   * repository; production defaults to the room-repo service, and to `null`
   * wherever no such service was bootstrapped.
   *
   * @param room - The room being answered.
   */
  roomConventions?: (room: Room) => Promise<string | null>;
}

/**
 * Say so, once, when the session about to take a room turn has no posting verb
 * (spec `tool-only-room-replies` §A2).
 *
 * ## It decides nothing — that is the point of it
 *
 * A room turn speaks by calling `post_to_room`, by reacting, or not at all.
 * There is no second delivery to fall back to, so a session that cannot reach
 * the tool is not refused, not muted and not treated specially: it runs its
 * turn, and if it ends having put nothing in front of anybody the room writes
 * the ordinary `agent_declined` line for a person who asked. That is the
 * behaviour a graduated feature owes — one path, whatever the wiring is doing.
 *
 * What it costs is a DIAGNOSTIC, and this is it. An agent that has gone quiet
 * because its MCP entry never got built looks, from the room, exactly like an
 * agent exercising judgment. The earlier revision of this file resolved a reply
 * mode here and fell back to posting the turn's text, which hid the same wiring
 * gap behind an answer nobody chose to send; the honest trade is to keep the one
 * behaviour and put the gap on the log where an operator can find it.
 *
 * ## Why an unimplemented question says nothing
 *
 * `carriesRoomTools` is a positive claim. A runtime that does not implement it
 * is not asserting that the tools are missing — it has not thought about the
 * question — and warning on every such turn would bury the one line that means
 * something under a runtime's silence. So only an explicit `false`, or a
 * question that threw, is worth a line.
 *
 * @param opts.runtime - The runtime about to take the turn.
 * @param opts.cwd - **Where the turn will actually RUN** — the agent's home for
 *   every room turn (spec `agent-home-desk` §5.1). It is the run cwd that is
 *   asked about, because that is what the two runtimes that can be given these
 *   tools key their MCP configuration on. The runtime resolves it to its agent
 *   itself (DOR-2091).
 * @param opts.sessionId - The session the turn will run on.
 * @param opts.agentPath - The agent the turn is FOR, which the runtime checks
 *   the directory's owner against exactly as its turn will (DOR-2091).
 */
export async function warnIfTurnCannotPost(opts: {
  runtime: Pick<AgentRuntime, 'carriesRoomTools'>;
  cwd: string;
  sessionId: string;
  agentPath: string;
}): Promise<void> {
  const { runtime, ...session } = opts;
  if (runtime.carriesRoomTools === undefined) return;
  try {
    if (await runtime.carriesRoomTools(session)) return;
    logger.warn('[rooms] this turn has no way to post, so it can only stay silent', {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      // Named rather than implied: the reachable causes are a directory that
      // anchors to no registered agent — or to a different one than the turn is
      // for — and a runtime boundary that is not up, and both are wiring an
      // operator can act on.
      reason: 'the runtime reports that this session does not carry the DorkOS room tools',
    });
  } catch (err) {
    logger.warn('[rooms] could not tell whether this turn can post', {
      sessionId: opts.sessionId,
      cwd: opts.cwd,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** The shipped wait, used when a caller supplies no reader. */
const DEFAULT_REPLY_WAIT_MS = 10 * 60_000;

/** The shipped ceiling, used when a caller supplies no reader. */
const DEFAULT_LATE_REPLY_CEILING_MS = 60 * 60_000;

/**
 * The production reader for a room's `ROOM.md` conventions block.
 *
 * Resolved through the registered room-repo service, and `null` when there is
 * none: a room turn is somebody's message being answered, and it must not fail
 * because an optional subsystem was never bootstrapped. The service's own
 * `hasRepo` — feature flag included — is what makes a room without files answer
 * `null` too, so nothing here needs a second copy of that question.
 *
 * @param room - The room being answered.
 * @returns The block, or `null` when this turn carries none.
 */
async function readRoomConventions(room: Room): Promise<string | null> {
  return (await tryGetRoomRepoService()?.conventionsFor(room)) ?? null;
}

/**
 * Which runtime one in-flight turn is ACTUALLY running on.
 *
 * The instance rather than its type name, because the instance is what a stop
 * has to reach and a re-fetch by name is a second lookup that can answer
 * differently. A box around it rather than the bare runtime, because the runtime
 * is a process-wide SINGLETON: two turns on one session share it, so only a
 * per-turn object can tell a turn's own cleanup from the next turn's entry.
 */

/**
 * Build the runner that turns a room trigger into a real session turn.
 *
 * @param options - Readers for the two bounds; the shipped numbers by default.
 * @returns A {@link RoomTurnRunner} bound to the process runtime registry.
 */
export function createSessionRoomTurnRunner(options: RoomTurnRunnerOptions = {}): RoomTurnRunner {
  const observeBeforeDispatch = options.observeBeforeDispatch;
  const readWaitMs = options.waitMs ?? (() => DEFAULT_REPLY_WAIT_MS);
  const readCeilingMs = options.ceilingMs ?? (() => DEFAULT_LATE_REPLY_CEILING_MS);
  const readGraceMs = options.waitingGraceMs ?? (() => WAITING_NOTICE_GRACE_MS);
  const readRoomConventionsBlock = options.roomConventions ?? readRoomConventions;
  /**
   * Sessions a Stop reached before their turn could be stopped — the boot
   * window (DOR-1424).
   *
   * **A stop pressed during boot has nothing to land on.** The runtime binds a
   * turn only once its process is up, so `interruptQuery` a moment earlier
   * answers `not-running` and stops nothing at all; the process then finishes
   * booting and runs the prompt to completion. Measured on 2026-08-17 (rooms run
   * F2): the interrupt reached a `bin/claude` that was still spawning and a
   * whole seven-thousand-character answer was produced afterwards. The room
   * already refuses to POST that answer (DOR-1313) — this is about not paying
   * for it.
   *
   * So the stop is remembered rather than dropped, and re-aimed once, at the
   * first thing the turn's runtime actually produces: by then the turn exists
   * and can be stopped, so it is stopped instead of run.
   *
   * **A SET, because the runtime to re-aim at is never this set's to remember**
   * (DOR-1721). It used to hold the runtime the earlier stop happened to reach —
   * which, on a first turn whose manifest was edited mid-flight, was a runtime
   * holding no such turn, so the re-aim faithfully repeated the misaim. The one
   * `run` that can consume a mark already holds the runtime its own turn is
   * running on, and that is the only correct target: a mark can only survive
   * into a run if it was set AFTER that run's top-of-run delete below, so a mark
   * this run finds was aimed at this run's turn. All this needs to carry is
   * whether a stop is owed.
   *
   * **And it is now only for the window before a turn has been captured**, which
   * is the narrowest this can be. Once the current turn map holds an
   * entry, a stop is owed to that TURN and is marked there
   * (the stop-state capture's stopOwed field) — because the turn answers to two names and
   * this set answers to one, so a halt arriving on a late answer, after
   * `onSessionBound` moved the room onto the canonical id, would be recorded
   * under a key the re-aim never reads. Marking the turn also makes the mark
   * un-inheritable: it dies with the object, so a stop meant for one turn cannot
   * be found by the next one however the halt addressed it.
   *
   * **`not-running` arms this, and NOTHING ELSE does** — narrowed from the
   * boolean's `!stopped`, which is not the same set (spec
   * `runtime-interrupt-receipts`). `unconfirmed` and `failed` also failed to
   * stop the turn, and arming on them would be a bug rather than a wider net:
   * both mean a turn IS already running and the runtime declined or could not be
   * reached, so a re-aim would fire a SECOND stop at a turn that is past its boot
   * window — the retry loop the "re-aimed ONCE" rule below exists to forbid,
   * arrived at from the other direction. This latch is for the one ending that
   * says the turn had not started yet.
   *
   * **Keyed by session, and cleared by the next turn on it**, which is the same
   * lifetime `RoomTriggerDispatcher.stoppedHere` keeps: a new turn is the room
   * asking again, and a stop left standing across it would kill a turn nobody
   * stopped. Re-aimed ONCE, never on a timer — a retry loop with no turn to
   * bound it is how a stop meant for one turn reaches the next one.
   *
   * **The third lifetime is that there isn't one**, and it is admitted here
   * rather than implied away: a stop recorded for a turn that then dies without
   * producing anything leaves its entry until the next `run` on that session id
   * — which for a pair whose room is archived, or whose agent leaves the roster,
   * never comes. What is retained is one string, so this is a
   * bounded-by-sessions-ever-stopped set and not a retention of anything a
   * session owns. Sweeping it would need a second lifetime to get wrong; being
   * one entry per abandoned session is the cheaper mistake.
   *
   * **It rests on one cross-module ordering invariant**, which is worth checking
   * if this ever stops working: the first event a turn puts on the projector
   * after its synthesized `turn_start` must mean the runtime has a turn that can
   * be interrupted. For claude-code that boundary is `bundle.booting = true` in
   * `sessions/persistent-dispatch.ts`, immediately before `recovery.dispatch` —
   * everything the pump yields BEFORE it (`plan.statusEvents`) is on the wrong
   * side of it. That is inert today because the only producer of a status event
   * there is the auto-permission-mode downgrade, and a room turn cannot be
   * `permissionMode: 'auto'`. **Read the current reason, not the old one**
   * (DOR-1917): a room turn used to take the runtime's own `'default'` because
   * it asked for no configured mode at all, and it now follows the operator's
   * trust stop like every other unattended surface. What keeps `'auto'` out is
   * narrower — `resolveTrustStops` returns the FIRST mode declared at a stop,
   * and claude-code declares `acceptEdits` before `auto` at `act`, so no stop
   * resolves to it. An adapter that reorders those two declarations makes this
   * reachable. A future status event yielded before the boot would spend this
   * one shot on nothing, with every test still green.
   */
  const stopState = createRoomTurnStopState<AgentRuntime>();
  /**
   * The runtime each session's live turn is running on — captured the moment
   * that turn's runtime is chosen, and the ONLY answer the stop path accepts
   * while it stands (DOR-1721).
   *
   * **`session_metadata` cannot answer this for a first turn, and that is the
   * whole bug.** The binding is written only once the turn LAUNCHES (see
   * `recordSessionOwner` below, taken back if no turn runs) — and for
   * claude-code the runtime then moves it to the CANONICAL id, while a halt
   * mid-turn asks about the placeholder the room bound before it. So for the length of a first turn `resolveTurnRuntimeType`
   * finds nothing bound and falls through to the agent's manifest. A manifest
   * edit landing inside that window aimed `interrupt` at a runtime holding no
   * such turn: `interruptQuery` answered `not-running`, the DOR-1424 latch below
   * memoized that wrong runtime and re-aimed the stop at it too, and the turn
   * nobody wanted ran to completion and was paid for. Traced out of DOR-764's
   * review (PR #1476) and reproduced in `room-turn-runner.test.ts`.
   *
   * **Captured where the decision is MADE, not where the row is written.** The
   * entry goes in beside `runtimeRegistry.get`, which is the line that commits
   * this turn to one runtime, so every moment from then until the turn can no
   * longer be running is covered — including the stretch before acceptance,
   * where the room is already holding a claim and a Stop can already arrive.
   * Nothing between those two points re-reads the manifest to answer "who is
   * running this"; ADR-0255's first-write-wins binding is untouched, because
   * this remembers the same type that write will use rather than deciding a
   * second one.
   *
   * **Keyed by every id this turn answers to.** The room may ask with the
   * placeholder it bound before the turn or, once `rebindRoomSession` has run,
   * with the canonical id the runtime renamed it to; both are registered, and
   * both are dropped together.
   *
   * **Dropped when the turn can no longer be running** — hung off the reply
   * collector, so the late window counts as running and a halt during it still
   * lands. The delete is identity-guarded: a turn's own cleanup must never
   * remove the entry the NEXT turn on that session has already written. The one
   * residue is the sibling map's, for the same reason and with the same bound: a
   * `run` that throws before its collector exists leaves one entry, holding a
   * string key and a runtime SINGLETON, until the next turn on that session
   * overwrites it — which the delete at the top of `run` also does.
   */

  /**
   * Deliver one stop to a runtime that is known to be the right one, and latch
   * it if it landed on nothing.
   *
   * Shared by the two ways {@link RoomTurnRunner.interrupt} finds its target —
   * the live turn's own capture, and the binding-then-manifest ladder for a
   * session with no turn in flight — so the receipt, the log line and the
   * DOR-1424 latch cannot drift apart between them.
   *
   * @param target - The runtime to stop.
   * @param sessionId - The session the stop is aimed at.
   */
  const deliverStop = async (
    runtime: AgentRuntime,
    sessionId: string,
    owe: () => void
  ): Promise<InterruptReceipt> => {
    const receipt = await runtime.interruptQuery(sessionId);
    logger.info('[rooms] interrupted a turn', { sessionId, ...receipt });
    if (receipt.outcome === 'not-running') {
      // **The stop landed on nothing, and the turn may still be COMING UP.**
      // A halt pressed while the agent's process is still starting reaches a
      // runtime that has not bound the turn yet, so there is nothing to
      // interrupt — and the turn then runs the prompt to completion, burning a
      // whole model turn nobody wanted (DOR-1424, rooms run F2 2026-08-17).
      // Remembering it is what lets the turn's own first output re-aim it.
      //
      // WHETHER a stop is owed is decided here, once, so the receipt and the
      // mark cannot drift apart. WHERE it is recorded is the caller's, because
      // the two callers have different things to write on: a halt that found the
      // live turn marks that turn, and a halt with no turn to find marks the
      // session (DOR-1721). Never the runtime this call reached — it may not be
      // the one running the turn, and whoever consumes the mark knows better.
      owe();
    }
    return receipt;
  };
  const originalRunKey = roomReplyFreeze({});
  roomReplyApply(roomReplySet, originalRoomTurnRunViews, [
    originalRunKey,
    roomReplyFreeze({
      get runner() {
        return runner;
      },
      stopState,
      readWaitMs,
      readCeilingMs,
      readGraceMs,
      readRoomConventionsBlock,
      observeBeforeDispatch,
      collectReply,
      copyOriginalRoomPermissionCeiling,
      originalPlacedContexts,
      originalCompletions,
      originalLaunches,
      originalPreparations,
      ROOM_CLIENT_ID,
    }),
  ]);
  const runner: RoomTurnRunner = {
    run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      return runOriginalRoomTurn(originalRunKey, request);
    },

    async interrupt({ sessionId, agentPath }): Promise<InterruptReceipt> {
      // **A turn that is running answers this question itself** (DOR-1721). The
      // runner captured its runtime when it committed to one, so while that
      // capture stands there is nothing to resolve: it IS the runtime holding
      // the turn, which is the only thing a stop can usefully reach. Asking the
      // ladder below instead is what a manifest edit landing inside a first turn
      // used to be able to change out from under the halt.
      const inFlight = stopState.current(sessionId);
      if (inFlight !== undefined) {
        // Marked on the TURN, under whichever of its two names this halt used.
        // A session-keyed mark could only ever be consumed under one of them, so
        // a halt that arrived after `onSessionBound` — which is every halt on a
        // late answer — was recorded where the re-aim does not look.
        return await deliverStop(inFlight.runtime, sessionId, () => {
          stopState.oweTurn(inFlight);
        });
      }

      // Nothing is running here, so the question is the ordinary one and is
      // answered exactly as `run` answers it: a stop aimed at a runtime other
      // than the one that would take this session's turn stops nothing.
      // The session's own binding answers first, and the agent's manifest only
      // where there is no binding to read.
      //
      // A session bound to a runtime this build does not have gets the same
      // refusal `run` gives it, with the same two recoveries (re-enable the
      // runtime, or remove and re-add the agent) — see the note above `run`'s
      // registration check. Nothing was running to stop in that state anyway,
      // since no turn could have started.
      const runtimeType = await resolveTurnRuntimeType({ sessionId, agentPath });
      // No runtime is no stop: nothing was reached, and saying so is the whole
      // point of answering at all (DOR-1425). `failed` rather than
      // `not-running` — a runtime this build does not have is a delivery
      // problem, not evidence that the turn was over. Asked as `has` rather
      // than inferred from a falsy `get`, which throws against the real
      // registry and left this branch reachable only from the tests' stub: a
      // halt pressed in a room whose runtime went away used to reject where it
      // is documented never to (DOR-1720). `run`'s refusal is the one that
      // writes the room's line; a stop is a control action and answers its
      // presser through the receipt.
      if (!runtimeRegistry.has(runtimeType)) {
        return { outcome: 'failed', reason: 'delivery-failed', runtime: runtimeType };
      }
      // No turn to mark, so the SESSION carries it — the pre-capture window,
      // and the only thing the pending session marks is still for.
      return await deliverStop(runtimeRegistry.get(runtimeType), sessionId, () =>
        stopState.oweSession(sessionId)
      );
    },
  };
  // Capture this constructor's own implementation before its original method
  // identity is registered. No caller wraps or replaces a registered runner.
  const runOriginal = runner.run;
  const observeRun = options.observeRun;
  runner.run = async (request) => {
    const finishing: { complete?: (completion: OriginalRoomRunnerCompletion) => void } = {};
    let current:
      | {
          request: RoomTurnRequest;
          observation: OriginalRoomRunnerObservation;
          defaults: { value?: OriginalRoomRunnerComputedDefaults };
        }
      | undefined;
    if (
      readOriginalSessionRoomRunner(runner) &&
      readOriginalRoomDispatchRequest(request, runner) &&
      readOriginalRoomRequestCurrent(request, runner)
    ) {
      const completion = new Promise<OriginalRoomRunnerCompletion>((resolve) => {
        finishing.complete = resolve;
      });
      const defaults: { value?: OriginalRoomRunnerComputedDefaults } = {};
      current = {
        request,
        defaults,
        observation: Object.freeze({
          completion,
          get computedDefaults() {
            return defaults.value;
          },
        }),
      };
      originalCompletions.set(runner, current);
      // The callback receives neither a request nor producer/placement authority.
      // It cannot delay this turn or replace its original result/raw failure.
      try {
        observeRun?.(request.entry.id, current.observation);
      } catch {
        // Passive observer failures, including undefined, never alter the turn.
      }
    }
    try {
      const result = await runOriginal.call(runner, request);
      finishing.complete?.(Object.freeze({ kind: 'returned', result }));
      return result;
    } catch (cause) {
      finishing.complete?.(Object.freeze({ kind: 'threw', cause }));
      throw cause;
    } finally {
      if (current && originalCompletions.get(runner) === current)
        originalCompletions.delete(runner);
    }
  };
  originalPlacedContexts.set(runner, new Map());
  originalRunners.set(runner, {
    identity: Object.freeze({}) as OriginalSessionRoomRunner,
    run: runner.run,
    interrupt: runner.interrupt,
  });
  return runner;
}

/**
 * The events that end one assistant message and begin the next.
 *
 * There is no message boundary on the durable session stream to read — the
 * normalizer's own doc says turn boundaries are synthesized and nothing carries
 * a message one — so this is the closest honest proxy, and it is exact for the
 * shape that matters. A model that stops to use a tool emits its text and the
 * `tool_use` in ONE message; the result comes back, and everything after it is a
 * NEW message. So text either side of a tool call was never one paragraph, and
 * concatenating it produced the observed `"…before answering.Congrats on…"` —
 * a pre-tool preamble welded to the answer with no space between them.
 *
 * `status_change` is deliberately NOT here, though it does fire at each
 * message's end (the SDK's `message_delta` token count maps onto it). It also
 * fires mid-message, so breaking on it would split single paragraphs at
 * unpredictable points. `thinking_delta` is not here either: reasoning precedes
 * the text of the message it belongs to, so it separates nothing on its own, and
 * anything that follows a tool result is caught by the boundary already.
 */
const MESSAGE_BOUNDARY = new Set(['tool_call', 'tool_result']);

/**
 * How long a turn may sit on a prompt before the room mentions it.
 *
 * **The notice is for a WAIT, not for a pause.** Nearly every gated tool call
 * is answered in seconds by whoever is already looking at that agent, and a
 * durable "Ana is waiting for you to approve something" above every one of
 * those answers would put a permanent line in the room for a state that lasted
 * three seconds — one per gated turn, in every room, forever. Over-participation
 * is the failure mode people actually complain about
 * (`meta/agent-etiquette.md`), and this notice would be the loudest source of
 * it in the product.
 *
 * A minute is the number because of what sits either side of it. Below it are
 * the approvals somebody is already handling, which need no announcement at
 * all. Above it is the incident this notice exists for: agents stopped for
 * twenty to forty-one minutes with nothing said anywhere (DOR-784). And it
 * spends only a tenth of the ten-minute countdown
 * (`SESSIONS.INTERACTION_TIMEOUT_MS`), so a person reading the line still has
 * about nine minutes before the card even parks, and hours before the agent
 * gives up — the room is late to speak, never too late to be useful.
 *
 * Deliberately a constant rather than configuration: it changes how chatty one
 * notice is, never what the room does, and there is no honest guidance to give
 * somebody tuning it (room-presence spec §10). Like every other threshold in
 * this domain it is **unsourced** — `meta/agent-etiquette.md` §9 — and picked to
 * be corrected by using the product.
 */
const WAITING_NOTICE_GRACE_MS = 60_000;
