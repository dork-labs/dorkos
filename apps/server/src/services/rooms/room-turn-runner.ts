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
import { randomUUID } from 'node:crypto';
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { Room } from '@dorkos/shared/room-schemas';
import {
  isBlockingInteractionEvent,
  type BlockingInteractionEventType,
  type SessionActivity,
} from '@dorkos/shared/session-stream';
import { logger } from '../../lib/logger.js';
import { ROOMS } from '../../config/constants.js';
import { projectRoomAttachments } from './attachments/attachment-projection.js';
import { getRoomAttachmentStore, tryGetRoomRepoService } from './index.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { resolveAgentRuntimeType } from '../runtimes/shared/resolve-agent-runtime-type.js';
import {
  dispatchMessage,
  getOrCreateProjector,
  deriveSessionActivity,
  persistenceModeFor,
  resolveUnattendedSessionDefaults,
  type SessionStateProjector,
} from '../session/index.js';
import type {
  LateRoomReply,
  RoomTurnRequest,
  RoomTurnResult,
  RoomTurnRunner,
  RoomTurnWaiting,
} from './room-trigger.js';

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
 * Build the runner that turns a room trigger into a real session turn.
 *
 * @param options - Readers for the two bounds; the shipped numbers by default.
 * @returns A {@link RoomTurnRunner} bound to the process runtime registry.
 */
export function createSessionRoomTurnRunner(options: RoomTurnRunnerOptions = {}): RoomTurnRunner {
  const readWaitMs = options.waitMs ?? (() => DEFAULT_REPLY_WAIT_MS);
  const readCeilingMs = options.ceilingMs ?? (() => DEFAULT_LATE_REPLY_CEILING_MS);
  const readGraceMs = options.waitingGraceMs ?? (() => WAITING_NOTICE_GRACE_MS);
  const readRoomConventionsBlock = options.roomConventions ?? readRoomConventions;
  /**
   * Sessions a Stop reached before their turn could be stopped — the boot
   * window (DOR-1424) — and the runtime to aim the stop at when it can be.
   *
   * **A stop pressed during boot has nothing to land on.** The runtime binds a
   * turn only once its process is up, so `interruptQuery` a moment earlier
   * answers `false` and stops nothing at all; the process then finishes booting
   * and runs the prompt to completion. Measured on 2026-08-17 (rooms run F2):
   * the interrupt reached a `bin/claude` that was still spawning and a whole
   * seven-thousand-character answer was produced afterwards. The room already
   * refuses to POST that answer (DOR-1313) — this is about not paying for it.
   *
   * So the stop is remembered rather than dropped, and re-aimed once, at the
   * first thing the turn's runtime actually produces: by then the turn exists
   * and can be stopped, so it is stopped instead of run.
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
   * never comes. What is retained is a string key and the runtime SINGLETON, so
   * this is a bounded-by-sessions-ever-stopped map and not a retention of
   * anything a session owns. Sweeping it would need a second lifetime to get
   * wrong; being one entry per abandoned session is the cheaper mistake.
   *
   * **It rests on one cross-module ordering invariant**, which is worth checking
   * if this ever stops working: the first event a turn puts on the projector
   * after its synthesized `turn_start` must mean the runtime has a turn that can
   * be interrupted. For claude-code that boundary is `bundle.booting = true` in
   * `sessions/persistent-dispatch.ts`, immediately before `recovery.dispatch` —
   * everything the pump yields BEFORE it (`plan.statusEvents`) is on the wrong
   * side of it. That is inert today because the only producer of a status event
   * there is the auto-permission-mode downgrade, and a room turn cannot be
   * `permissionMode: 'auto'` (it passes no `interactive` flag, so it takes the
   * runtime's `'default'`). A future status event yielded before the boot would
   * spend this one shot on nothing, with every test still green.
   */
  const stopsWaitingForATurn = new Map<string, AgentRuntime>();
  return {
    async run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      const sessionId = request.sessionId ?? randomUUID();
      // **This turn is the room asking again, so no older Stop is aimed at it**
      // (DOR-1424). A stop that never found a turn is remembered until one shows
      // up; the one it was meant for is the turn that was already running when
      // it was pressed, never this one.
      stopsWaitingForATurn.delete(sessionId);
      const runtimeType = await resolveAgentRuntimeType(request.agentPath);
      // Resolve the runtime WITHOUT writing anything. `persistSessionRuntime`
      // used to run here, before the turn was known to have started, so a
      // runtime that reliably throws left one orphan `session_metadata` row (and
      // one projector) per room message: `bindRoomSession` is never reached, the
      // next trigger mints a fresh UUID, and the dead row stays forever. The
      // registry's own docs warn about exactly this ghost-row shape.
      const runtime = runtimeRegistry.get(runtimeType);
      if (!runtime) throw new Error(`Runtime '${runtimeType}' is not registered`);

      // A room turn is the one place a session's first turn runs BEFORE its
      // `session_metadata` row exists, so it cannot inherit its model and effort
      // by reading that row — the ordering above is deliberate and stays. The
      // defaults are resolved here instead and handed to the turn directly; the
      // registry writes the same values onto the row it creates below, so the
      // second turn reads them the ordinary way. Rooms are the surface this
      // feature was most needed on: until now a room turn had no model or effort
      // path at all.
      //
      // Only for a session with no row yet. A room conversation that has already
      // run keeps what it is running with, exactly like every other session.
      //
      // One honest gap, which is a window rather than a state: a settings change
      // that lands between this read and the turn starting is outranked by the
      // seed for that ONE turn, because a per-send value beats the persisted row
      // by design. It self-heals — the row is there for every turn after — and
      // closing it would mean holding the session lock across a config read on
      // the room's hot path to fix a race a person can only lose by changing a
      // setting in the same instant a room message arrives.
      // Which `runtimes.*` section holds this runtime's defaults, and whether it
      // takes an effort at all, are the RUNTIME's own declarations. They are
      // handed to the resolver rather than looked up there: the registry imports
      // the resolver, so the arrow only points one way.
      //
      // A room turn always has an agent — it is the agent the room addressed —
      // and {@link resolveUnattendedSessionDefaults} is the same call a
      // relay-triggered turn makes, so the two surfaces answer identically for
      // one agent rather than drifting the way they did (DOR-1344).
      const seed =
        (await runtimeRegistry.getSessionSettings(sessionId)) === null
          ? await resolveUnattendedSessionDefaults({
              runtimeType,
              agentPath: request.agentPath,
              declared: runtime.getCapabilities().settings,
            })
          : {};

      // **A room turn always persists something, whatever the runtime.**
      //
      // For a log-backed runtime that is `'history'`, unchanged: the durable
      // rows ARE its transcript. For claude-code it is `'record'`, which is new
      // and narrow. Its history is SDK JSONL and stays there (ADR 260710-024641 —
      // persisting the whole stream would double-store and inflate the hot
      // path), so `'record'` keeps only each turn's two boundaries and any
      // error: three rows a turn, whatever the model said. The decision is
      // ADR 260731-211050.
      //
      // The reason rooms get this and the cockpit does not is that a room is the
      // one surface with NOBODY WATCHING. Everywhere else a person is holding
      // `GET /api/sessions/:id/events` while the turn runs, so a failure is on
      // their screen. A room triggers a turn into the dark; when one went silent
      // for forty-one minutes on 2026-07-31 there was not a single row anywhere
      // to say whether it had run, failed, or never started (DOR-784).
      // **The turn's own directory, handed over where the projector asks for
      // it** (DOR-1597). The second argument IS cwd — `request.agentPath` used
      // to be passed here and then overwritten a line later, which was both a
      // lie about what the argument means and a redundant write.
      //
      // `agentPath` and `cwd` are two values now: the first is identity, and
      // selects the runtime and keys the claim map; the second is where the turn
      // stands, and in a project room it is that agent's working copy of the
      // room's repo, resolved once by the dispatcher before the context that
      // names attachment paths relative to it was built (`resolve-session-cwd.ts`
      // rung 2, spec §3.5). For every room without files of its own they are the
      // same string.
      //
      // **Where this meets ROOM.md delivery (DOR-1593), and why nothing is owed
      // to it here.** The room's conventions block is read off the room repo's
      // MAIN checkout and rides `roomContext` like every other framing — it is a
      // fact about the ROOM, identical for every member, so it is deliberately
      // NOT read out of the tree this turn happens to stand in. A worktree may
      // be days behind main, or hold an agent's own edit to `ROOM.md`, and
      // neither may change what the room's conventions ARE. So the cwd rung
      // moves the turn and leaves that block exactly where it was:
      // cwd-independent, resolved upstream, never re-read from `request.cwd`.
      const projector = getOrCreateProjector(sessionId, request.cwd, {
        persist: persistenceModeFor(runtime.getCapabilities()),
      });

      // Take the cursor BEFORE triggering. Everything the turn emits has a seq
      // above it, so the collector cannot miss the opening of a fast turn — and
      // which of the turns above it is OURS is settled by identity, not by the
      // cursor: the dispatcher reports the seq it stamps this turn's `turn_start`
      // with, and the collector reads for exactly that one.
      //
      // The prompt IS the message, byte for byte. Everything else the agent
      // needs to know — the room, the roster, who is a person, what it missed —
      // rides `additionalContext` (ADR-0273). This used to be prose wrapped
      // around the message, which put words nobody typed inside the visible user
      // turn and told the agent almost nothing.
      //
      // Read off the REQUEST rather than off the entry: for every trigger the
      // dispatcher makes they are the same string, and the one caller where they
      // differ is the welcome-back offer, which asks about an entry rather than
      // repeating it (see {@link RoomTurnRequest.prompt}).
      const prompt = request.prompt;

      // Before the turn, never after: the context about to be handed to the
      // model names these files by relative path, so they have to be inside the
      // agent's working directory by the time it reads them (ADR 260807-233816).
      // It never throws — a missing file is survivable, a room that stopped
      // answering is not.
      await projectRoomAttachments({
        store: getRoomAttachmentStore,
        roomId: request.room.id,
        // The turn's own directory, not the agent's home. In a project room
        // those differ, and a file projected under the wrong one is a file the
        // model is told about by a relative path that does not resolve — which
        // is the exact invariant this projection exists to hold.
        cwd: request.cwd,
        attachments: request.attachmentProjection,
      });

      // **The room's own conventions, resolved ONCE and pinned to this turn**
      // (spec `project-rooms` §3.3). It is read HERE, at the top of the turn,
      // and the string is what the dispatch below carries: a merge that lands
      // while the model is mid-answer takes effect at the next turn boundary,
      // never under a running agent (the session-snapshot discipline,
      // ADR 260711-142049). That pin is this line's, not the composer's —
      // re-reading it at dispatch time would move the block under a turn that
      // had already been told something else.
      //
      // It rides `systemPromptAppend` rather than `additionalContext`, which is
      // the one place this domain departs from ADR-0273's default, and
      // deliberately: the bag is for what is true about THIS turn, and a room's
      // conventions are true about every turn — put there they would be re-sent
      // outside the cacheable prefix on every message, for the life of the
      // conversation. What ADR-0273 protects is `content`, which is untouched.
      //
      // `null` for every room with no files, which is every room today unless
      // the operator gave one a repo — so a non-repo room dispatches exactly the
      // arguments it did before this existed.
      //
      // **Guarded, because a throw out of `run` must mean NOTHING RAN.** The
      // dispatcher reads one as "the turn never started" and rewinds the room's
      // read cursor to replay the whole window (room-participation spec §8.3),
      // so a `SQLITE_BUSY` on the repo's cache row — or any future composer that
      // stops degrading on its own — would replay somebody's conversation
      // instead of dropping one optional block. The composer already answers
      // `null` for every git failure; this is the backstop for the seam itself,
      // and it fails the way the rest of this path does: the room still answers,
      // without its conventions.
      let roomConventions: string | null = null;
      try {
        roomConventions = await readRoomConventionsBlock(request.room);
      } catch (err) {
        logger.warn('[rooms] could not read the room’s conventions; answering without them', {
          roomId: request.room.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const waitMs = readWaitMs();
      // The turn's identity, filled in by the dispatcher the instant this turn's
      // `turn_start` is stamped and read by the collector to tell that event
      // from every other turn's. It is a shared box rather than a promise on
      // purpose: the collector must never AWAIT it, because a turn that is
      // refused never fills it and a collector parked on it would never settle
      // — which is a claim held, and an agent shown as working, for the life of
      // the process. Unknown means "not mine", which is exactly right.
      const ownTurn: OwnTurn = { startSeq: null };
      const collecting = collectReply(projector, projector.getCursor(), {
        waitMs,
        // A ceiling below the wait would stop the room listening before it
        // stopped waiting, so a perfectly healthy turn would be reported as
        // failed and its answer dropped — this PR's own defect, walked back in
        // through the settings screen. The two fields are independent and both
        // ranges are schema-valid, so clamp rather than trust the pair.
        //
        // Clamped SILENTLY, on purpose. The only place this code can speak is
        // the room, and a settings complaint posted into somebody's
        // conversation is noise aimed at the wrong person — the reader of a
        // room is usually not whoever set the number. Nothing is lost by
        // staying quiet either: the clamp is a floor, not an override, so a
        // ceiling above the wait still governs exactly as written. If this ever
        // needs to be surfaced, Settings is where it belongs, not here.
        ceilingMs: Math.max(readCeilingMs(), waitMs),
        ownTurn,
        onWaiting: request.onWaiting,
        onActivity: request.onActivity,
        graceMs: readGraceMs(),
        // **Where a Stop pressed during boot finally lands** (DOR-1424). The
        // first thing this turn's runtime produces is the proof that the turn
        // exists, which is exactly what the earlier interrupt was missing.
        onProducing: () => {
          const runtimeToStop = stopsWaitingForATurn.get(sessionId);
          if (runtimeToStop === undefined) return;
          stopsWaitingForATurn.delete(sessionId);
          logger.info('[rooms] a turn stopped while it was starting can be stopped now', {
            sessionId,
            roomId: request.room.id,
          });
          // Not awaited: this runs inside the collector's read of the stream the
          // interrupt is about to close, and a read that waits on its own
          // interrupt is a read that never resumes.
          void runtimeToStop
            .interruptQuery(sessionId)
            .then((stopped) => {
              if (stopped) return;
              logger.warn('[rooms] a turn stopped during its boot could not be stopped', {
                sessionId,
                roomId: request.room.id,
              });
            })
            .catch((err: unknown) => {
              logger.warn('[rooms] could not stop a turn that was stopped during its boot', {
                sessionId,
                roomId: request.room.id,
                error: err instanceof Error ? err.message : String(err),
              });
            });
        },
      });

      const result = await dispatchMessage({
        sessionId,
        clientId: ROOM_CLIENT_ID,
        content: prompt,
        cwd: request.cwd,
        roomContext: request.roomContext,
        // Omitted, never passed as an empty string, when this room has no files.
        // Not because `''` misbehaves today — it does not: all three adapters
        // guard with `if (opts?.systemPromptAppend)` and claude-code's launch
        // fingerprint digests the same base either way, so an empty append is
        // measurably inert right now. That is the point. It is inert only
        // because four separate consumers each happen to treat it as falsy, and
        // a guarantee resting on a coincidence is one refactor from being
        // false. Absent is the guarantee, and it is pinned at the two layers
        // below (`message-dispatcher.test.ts`).
        ...(roomConventions !== null ? { systemPromptAppend: roomConventions } : {}),
        settings: seed,
        projector,
        runtime,
        // **Refuse a stranger AT ACCEPTANCE**, unlike a person's own message: a
        // room turn accepted behind somebody else's would answer the room with
        // whatever THAT turn left behind, long after the room moved on. That is
        // what the skip notice below is for.
        //
        // **Its own previous turn is not a stranger** (DOR-1230). The room holds
        // a re-mention until this agent's claim here releases and then dispatches
        // it (RP8), so the turn ahead has already ENDED on the projector — but it
        // hands its in-flight slot back a beat later, when it settles. Refusing
        // that beat told the room the agent was busy, and the room posted "didn't
        // pick this up, send it again" over a message it was about to answer.
        // Waiting out its own tail is the whole difference between the two modes;
        // see {@link WhenBusy}.
        //
        // The refusal is therefore about the moment of ACCEPTANCE and nothing
        // after it. A trigger that was accepted — one waiting out its own tail —
        // and is then beaten to the session by a stranger goes back in line
        // rather than evaporating, and can run once that stranger's turn ends
        // (`DispatchPlan.answered`). That is deliberate: by then the room is
        // holding an `accepted: true` that cannot be taken back, and a late
        // answer beats a message that waits for a turn nothing will ever start.
        whenBusy: 'refuse-foreign',
        onTurnStart: (seq) => {
          ownTurn.startSeq = seq;
        },
        // **The one signal that an ACCEPTED trigger will never run** (DOR-1242).
        // A `refuse-foreign` trigger that waited out its own tail and then lost
        // the session to a stranger is dropped once its original wait is spent,
        // and `onSettled('failed')` is how the dispatcher says so. Without this
        // the room would keep waiting on a turn nothing would ever start: the
        // collector would report a late answer at `waitMs` and then "something
        // went wrong" at its ceiling, an hour after the message, over words the
        // model never saw.
        //
        // `startSeq === null` is what makes this safe to act on. It means no
        // `turn_start` was ever stamped for this dispatch, so no turn ran and
        // there is nothing left to hear. A turn that ran and genuinely FAILED
        // has a seq, keeps its existing path, and is reported by the collector
        // that watched it — this must not cut that short.
        onSettled: (outcome) => {
          if (outcome === 'failed' && ownTurn.startSeq === null) collecting.cancel();
        },
        onError: (err) => {
          logger.warn('[rooms] triggered turn errored', {
            sessionId,
            roomId: request.room.id,
            error: err instanceof Error ? err.message : String(err),
          });
        },
      });

      if (!result.accepted) {
        // Somebody else is writing to this session — the operator, most likely,
        // typing into the very agent the room just addressed. It is the ONLY way
        // to reach here now that the room waits out its own tail above, which is
        // what makes the notice this returns honest. Skipping the turn
        // is right: queueing a second one behind theirs would answer a room
        // message with whatever context their turn leaves behind. Skipping it
        // SILENTLY was not — the room reports it and the dispatcher writes the
        // notice, because a dropped trigger nobody mentions looks exactly like a
        // broken agent (DOR-621).
        collecting.cancel();
        logger.info('[rooms] skipped a trigger: the session is busy', {
          sessionId,
          roomId: request.room.id,
        });
        return { sessionId, text: null, unanswered: 'busy' };
      }

      const canonicalId = result.canonicalId ?? sessionId;

      // The turn started, so the session is real: record which runtime owns it.
      // The registry binds a session that has no runtime yet and leaves a bound
      // one untouched, so a resumed session is a no-op.
      //
      // No `interactive` flag, deliberately: the configured default trust stop
      // is for sessions a person is watching (spec `trust-dial`, decision 6).
      // A room turn runs into the dark, so it keeps the runtime's own default —
      // the same reason the seed above carries model and effort and nothing
      // about permissions.
      //
      // **BELOW the `!accepted` return, and its failure is LOGGED rather than
      // thrown.** Both halves of that are load-bearing, and it used to be one
      // `await` above the guard.
      //
      // This is bookkeeping about a turn that has already happened — the query
      // was accepted, the model streamed, the answer is sitting in `collecting`.
      // A `SQLITE_BUSY` on this row is a live hazard (`bindRoomSession` in
      // `room-trigger.ts` is try-wrapped for exactly it), and thrown from here it
      // escaped `run` entirely: the room reported a turn that ANSWERED as failed,
      // dropped the answer on the floor, and — because a throw out of `run` is
      // what the dispatcher reads as "the turn never started" — rewound the read
      // cursor and replayed the whole window to the next turn
      // (room-participation spec §8.3).
      //
      // So the invariant this line protects is the dispatcher's, not its own: a
      // throw out of `run` must mean NOTHING RAN. Nothing that happens after the
      // model has spoken may throw past here. What is lost when this fails is one
      // runtime-attribution row, which the next turn on this session rewrites.
      try {
        await runtimeRegistry.persistSessionRuntime(canonicalId, runtimeType, request.agentPath);
      } catch (err) {
        logger.warn('[rooms] could not record which runtime owns this session', {
          sessionId: canonicalId,
          roomId: request.room.id,
          runtimeType,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const reply = await collecting.beforeDeadline;
      if (!reply) {
        // The room stops WAITING here; the turn keeps running. Its answer is
        // posted when it lands, carrying how long it took.
        logger.info('[rooms] still working past the wait deadline; the answer will post late', {
          sessionId: canonicalId,
          roomId: request.room.id,
        });
        return { sessionId: canonicalId, text: null, late: collecting.afterDeadline };
      }

      return {
        sessionId: canonicalId,
        text: reply.text,
        ...(reply.failed ? { unanswered: 'failed' as const } : {}),
      };
    },

    async interrupt({ sessionId, agentPath }): Promise<boolean> {
      // The runtime is resolved from the AGENT, exactly as `run` resolves it,
      // rather than from the session's registry row: a first turn's row is
      // written after the turn starts, so a halt arriving early would otherwise
      // find nothing to stop.
      const runtime = runtimeRegistry.get(await resolveAgentRuntimeType(agentPath));
      // No runtime is no stop: nothing was reached, and saying so is the whole
      // point of answering at all (DOR-1425).
      if (!runtime) return false;
      const stopped = await runtime.interruptQuery(sessionId);
      logger.info('[rooms] interrupted a turn', { sessionId, stopped });
      if (!stopped) {
        // **The stop landed on nothing, and the turn may still be COMING UP.**
        // A halt pressed while the agent's process is still starting reaches a
        // runtime that has not bound the turn yet, so there is nothing to
        // interrupt — and the turn then runs the prompt to completion, burning a
        // whole model turn nobody wanted (DOR-1424, rooms run F2 2026-08-17).
        // Remembering it here is what lets the turn's own first output re-aim it;
        // see {@link stopsWaitingForATurn}.
        stopsWaitingForATurn.set(sessionId, runtime);
      }
      return stopped;
    },
  };
}

/** One turn's output, once it has closed one way or another. */
interface CollectedTurn {
  /** The agent's text, or `null` if it said nothing worth posting. */
  text: string | null;
  /** The turn ended in an error, or was given up on at the ceiling. */
  failed: boolean;
  /** How long the turn took, measured from the moment the room subscribed. */
  waitedMs: number;
}

/** What a subscription to one turn's output is collecting. */
interface ReplyCollector {
  /**
   * The turn's outcome if it closes within the wait deadline, `null` if the
   * deadline passes first. `null` is not "nothing to say" — it is "not yet".
   */
  beforeDeadline: Promise<CollectedTurn | null>;
  /**
   * The same turn's outcome, whenever it eventually closes. Read only after
   * {@link ReplyCollector.beforeDeadline} resolved `null`; it is the answer
   * that gets posted late.
   */
  afterDeadline: Promise<LateRoomReply>;
  /** Stop collecting — the turn never started. */
  cancel(): void;
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

/**
 * One turn's identity on the durable stream, shared between the trigger that
 * mints it and the collector that reads for it.
 *
 * `null` until the turn actually opens, and a collector treats `null` as "not
 * mine" rather than waiting — see where it is constructed.
 */
interface OwnTurn {
  /** The `seq` of this turn's `turn_start`, or `null` before it has one. */
  startSeq: number | null;
}

/**
 * Which kind of wait each blocking event is, in the room's vocabulary.
 *
 * A total map over {@link BlockingInteractionEventType} rather than a chain of
 * comparisons: a fourth way to park a turn on a person would be a type error
 * here rather than a room that silently stopped mentioning it.
 */
const WAITING_KINDS: Record<BlockingInteractionEventType, RoomTurnWaiting['kind']> = {
  approval_required: 'approval',
  question_prompt: 'question',
  elicitation_prompt: 'elicitation',
};

/**
 * Accumulate a turn's assistant text from the session's own event stream.
 *
 * **Bounded by its own turn, at both ends.** The read starts at this turn's
 * `turn_start` and stops at the matching `turn_end`, which is the same boundary
 * a client renders against. Anchoring only on the cursor was not enough: the
 * session write-lock lets the same room re-acquire (`session-lock.ts`), so a
 * follow-up message while a turn is running starts a second collector whose
 * cursor sits INSIDE the first turn's stream — it then broke at the first
 * turn's `turn_end` and posted its tail, mid-sentence, as the answer to the new
 * message. One question, two posts, the second a fragment of the first.
 *
 * Which `turn_start` is ours: the first one after the cursor that carries our
 * own prompt. `feedProjector` synthesizes exactly one per turn and echoes the
 * `content` it was triggered with, so this is an identity check rather than a
 * heuristic. A `turn_start` with no `userMessage` at all is accepted, because a
 * turn that does not say what triggered it cannot be attributed to anyone else
 * either, and waiting forever for a better one would report every turn as
 * failed.
 *
 * `turn_end` also carries `terminalReason`, which is how a turn that failed is
 * told from one that simply had nothing to say — the two used to be the same
 * `null` here, and the room reported neither.
 *
 * **Text is collected in paragraphs, not one string.** Every `text_delta` in the
 * turn used to be appended to a single buffer, so a message the agent wrote
 * before reaching for a tool was glued to the answer it wrote afterwards, with
 * no separator at all. Each run of deltas between {@link MESSAGE_BOUNDARY}
 * events is kept whole and the runs are joined with a blank line, so nothing is
 * dropped and the post reads the way the agent wrote it.
 *
 * ONE subscription serves both phases. The deadline resolves a race, it does
 * not abort the read: aborting at the deadline is what made a slow turn post
 * either nothing or a half-finished fragment of whatever it had streamed so far.
 *
 * @param projector - The session projector to read.
 * @param sinceCursor - The seq to resume from — taken before the turn starts.
 * @param bounds.waitMs - How long the room waits before moving on.
 * @param bounds.ceilingMs - When to give up on a turn that never closes.
 * @param bounds.ownTurn - This turn's identity, filled in when it opens.
 * @param bounds.onWaiting - Called when the turn has been stopped for a person
 *   for longer than `graceMs`, and is still stopped.
 * @param bounds.onActivity - Called with the tool this turn just started, and
 *   once with `null` when it can no longer be doing anything.
 * @param bounds.graceMs - How long a prompt may stand before it is mentioned.
 * @param bounds.onProducing - Called once, with the first event this turn's
 *   RUNTIME produced. Everything before it is DorkOS's own bookkeeping — the
 *   `turn_start` is synthesized here, before the runtime is even asked — so this
 *   is the earliest moment the turn is known to exist somewhere that can stop
 *   it (DOR-1424).
 */
function collectReply(
  projector: SessionStateProjector,
  sinceCursor: number,
  bounds: {
    waitMs: number;
    ceilingMs: number;
    ownTurn: OwnTurn;
    onWaiting: (waiting: RoomTurnWaiting) => void;
    onActivity: (activity: SessionActivity | null) => void;
    graceMs: number;
    onProducing: () => void;
  }
): ReplyCollector {
  const abort = new AbortController();
  const startedAt = Date.now();
  const ceiling = setTimeout(() => abort.abort(), bounds.ceilingMs);
  // `unref` so a pending room turn never holds the process open on shutdown.
  ceiling.unref?.();

  // Never rejects: both phases read this one promise, and the busy path reads
  // neither, so a rejection would surface as an unhandled one.
  /**
   * The grace timer for each prompt this turn is currently stopped on.
   *
   * Keyed by the interaction's own id so a turn stopped on two prompts at once
   * cancels exactly the one that was answered.
   */
  const waitingOn = new Map<string, ReturnType<typeof setTimeout>>();
  /** Forget one prompt's grace timer — it was answered, or the turn is over. */
  const stopWaitingOn = (id: string): void => {
    const grace = waitingOn.get(id);
    if (grace === undefined) return;
    clearTimeout(grace);
    waitingOn.delete(id);
  };
  /** Drop every outstanding grace timer. The turn is over; the wait is too. */
  const stopWaitingOnEverything = (): void => {
    for (const grace of waitingOn.values()) clearTimeout(grace);
    waitingOn.clear();
  };

  /** Whether this turn has already said it is doing nothing. */
  let cleared = false;
  /**
   * Say the turn is no longer doing anything nameable — at most once.
   *
   * Three endings reach it (the `turn_end` branch, the read failing, and the
   * ceiling or a cancel in the `finally`) and a turn that ends and is then
   * aborted reaches two of them. Once is what the room should hear: a second
   * clear is a second publish for work that was already over.
   */
  const clearActivity = (): void => {
    if (cleared) return;
    cleared = true;
    bounds.onActivity(null);
  };

  const closed: Promise<CollectedTurn> = (async () => {
    /** One assistant message's text, finished. */
    const paragraphs: string[] = [];
    /** The message being streamed right now. */
    let collecting = '';
    /** Close the open paragraph, keeping it only if the agent said something. */
    const endParagraph = (): void => {
      if (collecting.trim() !== '') paragraphs.push(collecting.trim());
      collecting = '';
    };
    let started = false;
    /** Whether the runtime behind this turn has produced anything yet. */
    let producing = false;
    let ended = false;
    let failed = false;
    try {
      for await (const event of projector.subscribe(sinceCursor, abort.signal)) {
        if (!started) {
          // Everything before our own turn opens belongs to somebody else's,
          // and "our own" is an identity rather than a resemblance.
          if (event.type !== 'turn_start' || event.seq !== bounds.ownTurn.startSeq) continue;
          started = true;
          continue;
        }
        // Past the synthesized `turn_start`, so this event came off the runtime:
        // the turn is really running, and a Stop that arrived while it was still
        // booting has something to aim at at last (DOR-1424).
        //
        // A `turn_end` is deliberately not "running": it is the turn being over,
        // and re-aiming a stop at a session whose turn has just closed is how a
        // stop meant for one turn lands on the one after it.
        if (!producing && event.type !== 'turn_end') {
          producing = true;
          bounds.onProducing();
        }
        // A prompt the turn has stopped on. It is reported after
        // {@link WAITING_NOTICE_GRACE_MS} and only if it is STILL unanswered
        // then — see that constant. Reported per prompt; the room damps
        // repeats, so a turn that stops three times still says so once.
        if (isBlockingInteractionEvent(event)) {
          const waiting: RoomTurnWaiting = {
            kind: WAITING_KINDS[event.type],
            ...(event.type === 'approval_required' ? { toolName: event.toolName } : {}),
          };
          const grace = setTimeout(() => {
            waitingOn.delete(event.id);
            bounds.onWaiting(waiting);
          }, bounds.graceMs);
          grace.unref?.();
          waitingOn.set(event.id, grace);
        }
        // Answered, denied, cancelled or timed out — every ending arrives here
        // (`interaction_cancelled` is normalized into this event), so the room
        // says nothing about a wait that is already over.
        if (event.type === 'interaction_resolved') stopWaitingOn(event.id);
        if (event.type === 'text_delta') collecting += event.text;
        else if (MESSAGE_BOUNDARY.has(event.type)) endParagraph();
        // What the turn is doing, for the room's own live lane (DOR-1351).
        // Derived by the SESSION's function, never a second one: the basename
        // rule, the first-line rule, the host rule and the 40-character
        // truncation are all its, and a second derivation is a second answer
        // that can disagree about one tool call.
        if (event.type === 'tool_call') {
          bounds.onActivity(deriveSessionActivity(event.toolName, event.input) ?? null);
        }
        if (event.type === 'turn_end') {
          ended = true;
          failed = event.terminalReason === 'error';
          clearActivity();
          break;
        }
      }
    } catch (err) {
      logger.warn('[rooms] could not read a turn off its session stream', {
        sessionId: projector.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      failed = true;
      clearActivity();
    } finally {
      clearTimeout(ceiling);
      // The turn has ended, one way or another. A prompt it was stopped on can
      // no longer be answered, so a notice about it now would be advice nobody
      // can act on — and a timer outliving its turn is a room that speaks about
      // work that is over.
      stopWaitingOnEverything();
      // The ceiling gave up, or the collector was cancelled. A verb that
      // outlives its turn is the one thing this feature must not do, so every
      // exit says so — and `clearActivity` makes saying it three times cost one
      // publish.
      clearActivity();
    }
    // Whatever was streaming when the turn closed — or when the ceiling gave up
    // on it — is a paragraph too. An abandoned read still keeps what it heard.
    endParagraph();
    return {
      text: paragraphs.length === 0 ? null : paragraphs.join('\n\n'),
      // A stream that ends without a `turn_end` was aborted — the ceiling, or a
      // cancel. Either way nobody got an answer, which is a failure to report.
      failed: failed || !ended,
      waitedMs: Date.now() - startedAt,
    };
  })();

  let deadline: ReturnType<typeof setTimeout> | undefined;
  const passed = new Promise<null>((resolve) => {
    deadline = setTimeout(() => resolve(null), bounds.waitMs);
    deadline.unref?.();
  });

  return {
    beforeDeadline: Promise.race([
      closed.then((turn) => {
        clearTimeout(deadline);
        return turn;
      }),
      passed,
    ]),
    afterDeadline: closed.then((turn) => ({
      text: turn.text,
      waitedMs: turn.waitedMs,
      ...(turn.failed ? { unanswered: 'failed' as const } : {}),
    })),
    cancel: () => {
      abort.abort();
      clearTimeout(ceiling);
      clearTimeout(deadline);
      stopWaitingOnEverything();
    },
  };
}
