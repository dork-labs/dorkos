/** The original runner turn body, with no externally registerable callback authority. */
import type { OwnTurn } from './turn/room-reply-collector-contracts.js';
import { createRoomLaunchOwnerRollback } from './turn/room-launch-owner-rollback.js';
import { shouldCancelUnstartedRoomReply } from './turn/room-reply-turn-data.js';
import { aliasTurnLevel } from '../core/turn-power/turn-levels.js';
import { randomUUID } from 'node:crypto';
import { type RoomContextData } from '@dorkos/shared/additional-context';
import { logger } from '../../lib/logger.js';
import { projectRoomAttachments } from './attachments/attachment-projection.js';
import { ulid } from 'ulidx';
import { getRoomAttachmentStore } from './index.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import { assertOwnDesk } from '../core/agent-identity/index.js';
import { refusePausedRoomTurn } from './turn-guards/paused-turn.js';
import { sessionStandsInRoomCopy } from './repo/room-turn-place.js';
import { RoomTurnRuntimeGoneError } from './room-turn-port.js';
import { resolveTurnRuntimeType } from '../runtimes/shared/resolve-agent-runtime-type.js';
import {
  getOrCreateProjector,
  onProjectorRekey,
  peekProjector,
} from '../session/session-state-projector.js';
import { persistenceModeFor } from '../session/projector-persistence.js';
import {
  resolveUnattendedSessionDefaults,
  resolveUnattendedPermissionMode,
  readAgentExecutionDefaults,
} from '../session/resolution/resolve-session-defaults.js';
import {
  dispatchOriginalRoomMessage,
  type DispatchMessageOpts,
} from '../session/message-dispatcher.js';
import {
  readOriginalRoomDispatchRequest,
  readOriginalRoomRequestCurrent,
  readOriginalRoomSessionOwner,
} from './service/room-core.js';
import { RoomError } from './data/room-errors.js';
import type { RoomTurnRequest, RoomTurnResult } from './room-trigger.js';
import {
  readOriginalRoomTurnRunView,
  warnIfTurnCannotPost,
  readOriginalRoomRunnerLaunch,
  readOriginalSessionRoomRunner,
} from './room-turn-runner.js';

/** Execute the complete original session-backed room turn only after its factory-private key is recognized. */
export async function runOriginalRoomTurn(
  opaqueRunnerTurnKey: object,
  request: RoomTurnRequest
): Promise<RoomTurnResult> {
  const facet = readOriginalRoomTurnRunView(opaqueRunnerTurnKey);
  // A paused agent starts no turn; private owner recognition precedes refusal.
  refusePausedRoomTurn(opaqueRunnerTurnKey, request);
  // Fixed captured function identities remain free calls, preserving their original undefined receiver.
  const {
    readWaitMs,
    readCeilingMs,
    readGraceMs,
    readRoomConventionsBlock,
    observeBeforeDispatch,
    collectReply,
    copyOriginalRoomPermissionCeiling,
  } = facet;
  // The session this (room, agent) is bound to — unless it cannot be carried
  // to the agent's home (below), in which case this turn starts a fresh one.
  let boundSessionId = request.sessionId;
  let sessionId = boundSessionId ?? randomUUID();
  // **This turn is the room asking again, so no older Stop is aimed at it**
  // (DOR-1424). A stop that never found a turn is remembered until one shows
  // up; the one it was meant for is the turn that was already running when
  // it was pressed, never this one.
  facet.stopState.begin(sessionId);
  // And no OLDER turn's capture stands for this session either: this one is
  // about to write its own a few lines down, and a `run` that threw before
  // it got there must not leave the stop path aiming at a turn that ended
  // (see the current turn map).

  // **The runtime that started this conversation is the one that finishes
  // it** (ADR-0255, DOR-764). Read off the session's binding, and off the
  // agent's manifest only for a session nobody owns yet — which is a first
  // turn, and the reason this is not simply `resolveForSession`: an unbound
  // id resolves through the registry's legacy claude-code inference, so a
  // codex agent's opening room turn would run on the wrong program.
  //
  // Re-reading the manifest every turn, as this line did, meant an edit made
  // mid-conversation silently moved the room's remaining turns onto a
  // different runtime — one holding none of that session's history, while
  // `session_metadata` still named the old owner (`persistSessionRuntime`
  // refuses to re-bind). The manifest governs the NEXT session now, exactly
  // as it does for the cockpit, the relay and every scheduled run.
  //
  // `boundSessionId`, not the minted `sessionId` above: an id this line
  // just invented has nothing to consult, and asking about it would spend a
  // read to be told so.
  let runtimeType = await resolveTurnRuntimeType({
    sessionId: boundSessionId,
    agentPath: request.agentPath,
  });
  // **An OpenCode session that stood in the room's copy cannot move home**
  // (spec `agent-home-desk` §8.1, measured): every session-scoped call routes
  // by the directory the session was created in, and it cannot be changed.
  // Room turns before this spec stood in the agent's copy of the room's
  // files, so such a session's next turn starts a fresh one at home; the
  // room's own log carries the conversation, and the old session stays in
  // the agent's list.
  if (
    boundSessionId !== null &&
    runtimeType === 'opencode' &&
    runtimeRegistry.has(runtimeType) &&
    (await sessionStandsInRoomCopy(runtimeRegistry.get(runtimeType), boundSessionId, request))
  ) {
    logger.info('[rooms] starting a fresh session at the agent’s home for this room', {
      roomId: request.room.id,
      previousSessionId: boundSessionId,
    });
    boundSessionId = null;
    sessionId = randomUUID();
    facet.stopState.clearPending(sessionId);
    runtimeType = await resolveTurnRuntimeType({
      sessionId: null,
      agentPath: request.agentPath,
    });
  }
  // Resolve the runtime WITHOUT writing anything. `persistSessionRuntime`
  // used to run here, before the turn was known to have started, so a
  // runtime that reliably throws left one orphan `session_metadata` row (and
  // one projector) per room message: `bindRoomSession` is never reached, the
  // next trigger mints a fresh UUID, and the dead row stays forever. The
  // registry's own docs warn about exactly this ghost-row shape. It is now
  // written at LAUNCH and taken back when no turn runs (DOR-2447).
  //
  // **A session bound to a runtime this build does not have refuses, every
  // turn.** Refusing is the right answer — the alternative is resuming
  // somebody's conversation on a program that holds none of it — and it is
  // not self-healing, because nothing clears a `(room, agent)` binding
  // except removing that agent from the room. The recovery is one of two
  // operator actions: re-enable the runtime the conversation started on, or
  // remove and re-add the agent, which drops the binding and lets its next
  // turn start a fresh session on whatever the manifest now says. That
  // second one is also how a deliberate runtime change is applied to a room
  // that is already running.
  //
  // **The refusal is NAMED, and that is DOR-1720.** Asking `get` first threw
  // a bare `Error` that `room-trigger.ts` could only read as "the turn
  // failed", so a room in this state apologised once per message forever,
  // pointed the reader at a session no turn had ever opened, and named
  // neither the program nor either recovery — a dead room with no way out of
  // it from inside. Asked as `has` and raised as
  // {@link RoomTurnRuntimeGoneError}, it reaches the dispatcher carrying the
  // runtime, which is the fact the room's line is written out of.
  //
  // `boundSessionId`, which is what the binding was read off. It is
  // non-null whenever this branch is reachable — an unbound session resolves
  // through the agent's manifest, and `resolveAgentRuntimeType` never
  // returns a type the registry does not have — so the null carries through
  // to the message rather than being papered over with the id this call
  // just invented, which nothing is bound to.
  if (!runtimeRegistry.has(runtimeType)) {
    throw new RoomTurnRuntimeGoneError(runtimeType, boundSessionId);
  }
  const runtime = runtimeRegistry.get(runtimeType);
  // **The desk guard** (spec `agent-home-desk` §3.4, invariant I3, DOR-2356).
  // A room turn stands in its agent's home and nowhere else — never a room's
  // folder, never another agent's home or a copy of it. Asked before anything
  // is registered or written, so a refusal is a turn that never started, which
  // is exactly what a throw out of `run` must mean.
  assertOwnDesk(request.agentPath, request.cwd, 'home');
  // **This turn is committed to that runtime as of this line, so the stop
  // path is told so as of this line** (DOR-1721). Everything below runs on
  // this instance; nothing re-derives it, and from here until the turn can
  // no longer be running `interrupt` reads it from here rather than asking
  // the manifest — which for a first turn is a question with a different
  // answer the moment somebody edits `.dork/agent.json`.
  const inFlight = facet.stopState.capture(sessionId, runtime);
  let canonicalId = sessionId;
  let stopRekeys = (): void => {};
  /** Retire this turn's exact rekey listener and all of its captured aliases. */
  const forgetTurnRuntime = (): void => {
    stopRekeys();
    facet.stopState.forget(inFlight);
  };

  // **Whether this session can post at all, asked once and only to say so**
  // (spec `tool-only-room-replies` §A2). It steers nothing: the turn runs
  // either way, and a turn that posts nothing is silence. See
  // {@link warnIfTurnCannotPost} for why the honest answer to a wiring gap
  // is a log line rather than a second delivery.
  //
  // **`request.cwd` for where, `request.agentPath` for whom** (DOR-2091). For
  // a room turn the two are the same folder — the agent's home — and every
  // runtime resolves identity through `resolveAgentHome`
  // (`core/agent-identity/agent-home.ts`) against the agent this turn names.
  // This line warns only when that wiring genuinely fails.
  await warnIfTurnCannotPost({
    runtime,
    cwd: request.cwd,
    sessionId,
    agentPath: request.agentPath,
  });
  const roomContext: RoomContextData = request.roomContext;

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
  //
  // **For the permission mode that window has a direction worth naming**: the
  // change that loses is a TIGHTENING, which is the one direction the product
  // says out loud everywhere else (`isTightening` in `permission-semantics`,
  // and `permissionModePendingUntilNextTurn` on the session route). It is one
  // turn, and it is reachable only by lowering the default in the same beat a
  // room message arrives for a session that has no row yet — but a tightening
  // that silently does not land is worth knowing about, not worth rounding
  // off into the model-and-effort sentence above.
  // Which `runtimes.*` section holds this runtime's defaults, and whether it
  // takes an effort at all, are the RUNTIME's own declarations. They are
  // handed to the resolver rather than looked up there: the registry imports
  // the resolver, so the arrow only points one way.
  //
  // A room turn always has an agent — it is the agent the room addressed —
  // and {@link resolveUnattendedSessionDefaults} is the same call a
  // relay-triggered turn makes, so the two surfaces answer identically for
  // one agent rather than drifting the way they did (DOR-1344).
  //
  // **The power level rides the same seed, and it is asked for SEPARATELY**
  // (DOR-1917). `resolveUnattendedSessionDefaults` answers model and effort
  // and no permission tier — not because a room may not have one, but
  // because a permission mode arriving as a side effect of asking about a
  // model would be an escalation nobody wrote down. So the room asks
  // {@link resolveUnattendedPermissionMode} by name, which is the same
  // question the scheduled-run path asks and the same mapping the dial
  // renders from. That is what makes a room the third surface to follow the
  // operator's level rather than the one left behind (ADR 260822-235802 as
  // amended by 260908-170643): a person who set every new conversation to
  // Full autonomy was getting a room agent that stopped to ask, in the one
  // place nobody is there to answer. Unset config resolves to `undefined`
  // and the runtime's own default stands, byte-for-byte as before.
  //
  // **This copy is for THIS TURN, not for the row** (DOR-2105). The
  // `session_metadata` seed asks the same question through the required
  // turn origin handed to `persistSessionRuntime` below, so the room no
  // longer decides its own power for the row. What is still needed here is
  // the mode this first turn LAUNCHES at: the row is written after the turn
  // starts (deliberately — see the comment on that call), so the very first
  // turn cannot inherit a posture the ordinary way and every later one
  // must. Both copies ask `resolveUnattendedPermissionMode` against this
  // same runtime's profile, so they cannot disagree.
  const isNewSession = (await runtimeRegistry.getSessionSettings(sessionId)) === null;
  // **And only for a message somebody on this machine wrote.** A bridged
  // Telegram or Slack chat is a projection of a relay binding into a room,
  // so a stranger's message reaches this same path — and a binding carries
  // its own grant precisely because nobody picked a mode for messages from
  // off this machine (DOR-604). Seeding the operator's level here would make
  // the bridged path strictly looser than the binding beside it, for the
  // same sender, which is the one thing the amended ADR promises it is not.
  // The row half of that rule is `externalAuthor` on the turn origin.
  // The addressed agent's own Files & commands stop beats the operator's
  // (spec `agent-permissions` D16), exactly as it does for the row's seed.
  const agentStop =
    isNewSession && !request.externalAuthor
      ? (await readAgentExecutionDefaults(request.agentPath)).filesAndCommands
      : undefined;
  const unattendedMode =
    isNewSession && !request.externalAuthor
      ? resolveUnattendedPermissionMode({
          capabilities: runtime.getCapabilities(),
          ...(agentStop ? { agent: { filesAndCommands: agentStop } } : {}),
        })
      : undefined;
  const seed = isNewSession
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
  // it** — the agent's home (spec `agent-home-desk` §5.1).
  //
  // **Where this meets ROOM.md delivery (DOR-1593).** The room's conventions
  // block is read off the room repo's MAIN checkout and rides `roomContext`
  // like every other framing — a fact about the ROOM, identical for every
  // member, never read out of the agent's copy, which may be days behind main
  // or hold the agent's own edit to `ROOM.md`.
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
    // The turn's own directory — the agent's home — which is what the
    // context's attachment paths are relative to.
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
  const placedContexts = facet.originalPlacedContexts.get(facet.runner)!;
  if (
    readOriginalRoomDispatchRequest(request, facet.runner) &&
    readOriginalRoomRequestCurrent(request, facet.runner)
  )
    placedContexts.set(sessionId, request);
  try {
    roomConventions = await readRoomConventionsBlock(request.room);
  } catch (err) {
    logger.warn('[rooms] could not read the room’s conventions; answering without them', {
      roomId: request.room.id,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    if (placedContexts.get(sessionId) === request) placedContexts.delete(sessionId);
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
  // **This turn's dispatch id, minted once and used in three places.** It
  // travels to the runtime as `MessageOpts.roomTurn.turnId`, so the
  // claude-code `control_ui` handler counts its canvas changes against the
  // same ceiling this collector's tap does; and it is what
  // `RoomCanvasService.finishTurn` composes the turn's one line from. One id
  // is what makes the handler's ledger and the tap's the SAME ledger.
  const canvasTurnId = ulid();
  const collecting = collectReply(projector, projector.getCursor(), {
    waitMs,
    roomId: request.room.id,
    authorId: request.authorId,
    turnId: canvasTurnId,
    // The tree this turn stands in, so a file document the tap writes
    // records where its path was resolved — and every later read of it is
    // judged against that directory rather than against nothing.
    cwd: request.cwd,
    // The agent's copy of the room's files, so a document naming a file by
    // an absolute path inside it is labelled as the copy (§5.6).
    worktree: request.worktree,
    // And how far that copy is ahead of the room's `main`, as the dispatcher
    // measured it for this turn. `null` is "not measured".
    aheadOfMain: request.roomContext.files?.ahead ?? null,
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
      // **Two places a stop can be owed from, and both are asked.** A halt
      // that found this turn's capture marked the TURN, under whichever of
      // its two names it used; a halt that arrived before the capture
      // existed could only mark the session. `delete` answers whether there
      // was a session mark, so that read and its consume-once are one
      // operation rather than two that can disagree — and it is evaluated
      // even when the turn is already marked, so a session mark cannot be
      // left standing for the next turn to find.
      if (!facet.stopState.consume(inFlight, sessionId)) return;
      logger.info('[rooms] a turn stopped while it was starting can be stopped now', {
        sessionId,
        roomId: request.room.id,
      });
      // **`runtime`, the one this turn is actually running on** (DOR-1721).
      // The earlier stop may have been delivered elsewhere — before the
      // capture below exists, `interrupt` has only the manifest to go on,
      // and a manifest edited inside a first turn answers with a runtime
      // holding no such turn. Re-aiming at whatever that call reached
      // repeated the misaim; the mark says only that a stop is owed, and
      // this closure is what knows where it is owed.
      //
      // Not awaited: this runs inside the collector's read of the stream the
      // interrupt is about to close, and a read that waits on its own
      // interrupt is a read that never resumes.
      void runtime
        .interruptQuery(sessionId)
        .then((receipt) => {
          // **Read as a RECEIPT, which it has been since DOR-1425.** This
          // was `if (stopped) return`, written against the boolean the
          // receipt replaced — and every receipt is an object, so the
          // truthy test always returned and this warning has not been
          // reachable since. `acked` and `closed` are the two endings that
          // mean the turn is over; everything else is a re-aim that arrived
          // and still did not stop it, which is the one thing this line is
          // for. Same reading `room-trigger.ts` gives the receipt.
          if (receipt.outcome === 'acked' || receipt.outcome === 'closed') return;
          logger.warn('[rooms] a turn stopped during its boot could not be stopped', {
            sessionId,
            roomId: request.room.id,
            ...receipt,
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
  // Late canonical bookkeeping remains best effort. Required original
  // launch preparation separately refuses a failed owner write.
  const launchOwnerRollback = createRoomLaunchOwnerRollback();
  const recordSessionOwner = async (
    ownedId: string
  ): Promise<{ ok: true; bound: boolean } | { ok: false; cause: unknown }> => {
    try {
      const bound = await runtimeRegistry.persistSessionRuntime(
        ownedId,
        runtimeType,
        { kind: 'room', externalAuthor: request.externalAuthor },
        request.agentPath
      );
      if (typeof bound !== 'boolean')
        throw new Error('Original session owner write returned no binding outcome.');
      return { ok: true, bound };
    } catch (err) {
      try {
        logger.warn('[rooms] could not record which runtime owns this session', {
          sessionId: ownedId,
          roomId: request.room.id,
          runtimeType,
          error: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* The actual owner-write failure, including undefined, remains first. */
      }
      return { ok: false, cause: err };
    }
  };

  // Capture the actual terminal id before retiring this turn's exact aliases
  // and rekey listener. Best-effort DB latency must not extend stop ownership.
  // A real started error still owns its canonical session; an unstarted
  // cancellation must not create a row. Late delivery keeps its original promise.
  const attributedCompletion = collecting.afterDeadline
    .then(async (reply) => {
      const finalId = canonicalId;
      const ownsFinalSession =
        ownTurn.startSeq !== null &&
        facet.stopState.current(finalId) === inFlight &&
        projector.sessionId === finalId &&
        peekProjector(finalId) === projector;
      forgetTurnRuntime();
      if (ownsFinalSession) await recordSessionOwner(finalId);
      return reply;
    })
    .finally(forgetTurnRuntime);
  void attributedCompletion.catch(() => undefined);

  // A rename may arrive after admission, or even before its response. Follow
  // only this turn's actual captured projector and still-current runtime slot.
  stopRekeys = onProjectorRekey((oldId, newId) => {
    if (
      facet.stopState.current(oldId) !== inFlight ||
      projector.sessionId !== newId ||
      peekProjector(newId) !== projector
    ) {
      return;
    }
    canonicalId = newId;
    facet.stopState.alias(newId, inFlight);
    aliasTurnLevel(oldId, newId);
  });

  // Taken back only for an id this run minted, and only while this process
  // lives: a server that dies between the launch-time write and the turn
  // starting leaves one unused row for an id nothing will ever bind — the
  // same exposure a person's first message has, and harmless (no room
  // points at it).
  const forgetLaunchRow = async (): Promise<void> => {
    if (!launchOwnerRollback.take()) return;
    await runtimeRegistry.forgetUnstartedSession(sessionId).catch((err: unknown) => {
      logger.warn('[rooms] could not take back the binding of a turn that never ran', {
        sessionId,
        roomId: request.room.id,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  };

  const originalPrepareLaunch = request.prepareLaunch;
  const dispatchOpts: DispatchMessageOpts = {
    sessionId,
    clientId: facet.ROOM_CLIENT_ID,
    content: prompt,
    cwd: request.cwd,
    // The agent this turn is dispatched AS, in the runtime-neutral field
    // every named-agent dispatch uses (spec `agent-home-desk` §4.1).
    forAgent: request.agentPath,
    // Exactly the folders placement granted THIS turn (invariant I5): the
    // agent's copy of the room's files and the room's shared tree. Absent
    // for a room without files, which grants nothing.
    ...(request.additionalDirectories.length > 0
      ? { additionalDirectories: request.additionalDirectories }
      : {}),
    // Run at LAUNCH — immediately, or when a turn queued behind this
    // session's running one is released — never at placement (§5.9, §6.1).
    //
    // **The session's owner is recorded here first** (DOR-2447). A runtime
    // may ask the server for authority the moment its turn starts — codex
    // and opencode open the agent's connections before the model runs — and
    // the server grants that only for a session whose runtime and agent are
    // on record (`CanonicalConnectorRuntimeAuthorityResolver`). Written after
    // acceptance only, every codex agent's FIRST room turn was refused. At
    // launch, under this turn's lock, it is written exactly when a turn
    // starts: a dispatch refused before launching writes nothing, so the
    // ghost-row case the late write below was moved for stays closed. The
    // late write stays too, for the id a runtime renames the session to.
    //
    // BEFORE the room's own launch step. Original Room preparation must
    // complete and retain its real native owner before provider entry;
    // ordinary non-Room preparation still has its generic fallback.
    //
    // Then the room's step: its files section, which carries the
    // turn-start refresh's outcome and the counts measured after it,
    // replaces the one placement measured, so the model is told about the
    // files as they are when it starts (I8).
    prepareLaunch: async () => {
      facet.originalPreparations.delete(request);
      // Only a row for an id this run MINTED is ever taken back below.
      const ownership = await recordSessionOwner(sessionId);
      if (!ownership.ok) throw ownership.cause;
      launchOwnerRollback.record(ownership.bound, boundSessionId === null);
      if (!readOriginalRoomSessionOwner(request, facet.runner, sessionId))
        throw new RoomError('ROOM_NOT_FOUND', 'No such room');
      // Native request lifetime is required even for an ordinary at-home
      // turn whose unavailable files produced no prepareLaunch function.
      if (
        !readOriginalRoomDispatchRequest(request, facet.runner) ||
        !readOriginalRoomRequestCurrent(request, facet.runner)
      )
        throw new RoomError('ROOM_NOT_FOUND', 'No such room');
      if (originalPrepareLaunch === undefined) {
        facet.originalPreparations.set(request, {
          runner: facet.runner,
          sessionId,
          prepare: originalPrepareLaunch,
        });
        return {};
      }
      if (
        Object.getOwnPropertyDescriptor(request, 'prepareLaunch')?.value !==
          originalPrepareLaunch ||
        !readOriginalRoomDispatchRequest(request, facet.runner) ||
        !readOriginalRoomRequestCurrent(request, facet.runner) ||
        facet.originalLaunches.has(request)
      )
        throw new RoomError('ROOM_NOT_FOUND', 'No such room');
      const launch = {
        runner: facet.runner,
        sessionId,
        prepare: originalPrepareLaunch,
        active: true,
      };
      facet.originalLaunches.set(request, launch);
      try {
        const launched = await originalPrepareLaunch.call(request, sessionId);
        if (!readOriginalRoomRunnerLaunch(request))
          throw new RoomError('ROOM_NOT_FOUND', 'No such room');
        const prepared = launched.files
          ? { roomContext: { ...roomContext, files: launched.files } }
          : {};
        if (!readOriginalRoomRunnerLaunch(request))
          throw new RoomError('ROOM_NOT_FOUND', 'No such room');
        facet.originalPreparations.set(request, {
          runner: facet.runner,
          sessionId,
          prepare: originalPrepareLaunch,
        });
        return prepared;
      } finally {
        launch.active = false;
        facet.originalLaunches.delete(request);
      }
    },
    roomContext,
    // Routing metadata, never prompt context: the room, the acting member and
    // this turn's id, so a `control_ui` the turn takes lands on the ROOM's
    // shared canvas rather than on this agent's private session stream
    // (spec `room-canvas` §5.3).
    roomTurn: {
      roomId: request.room.id,
      authorId: request.authorId,
      turnId: canvasTurnId,
      cwd: request.cwd,
      // The agent's copy of the room's files, so a canvas document naming a
      // file by an absolute path inside it is labelled as this agent's copy
      // (spec `agent-home-desk` §5.6).
      ...(request.worktree !== null ? { worktree: request.worktree } : {}),
      // Who this turn is FOR. The runtime resolves the turn's identity
      // against it, so a turn can act as this agent and no other, wherever
      // it stands (DOR-2091).
      agentPath: request.agentPath,
      // Measured once, here, by the code that already measured it for the
      // context block. `null` means git could not be asked — never "level".
      aheadOfMain: request.roomContext.files?.ahead ?? null,
    },
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
    // The power level travels in its OWN argument, not folded into the seed
    // above: `settings` is preference and this is posture, and a field named
    // for the one condition it may ride under is what keeps a future caller
    // from sending it for a session that already has a row (DOR-1917).
    ...(unattendedMode !== undefined ? { newSessionPermissionMode: unattendedMode } : {}),
    // And the bound on THIS turn, from who wrote the message: applied by the
    // runtime on top of whatever the conversation is set to, and never
    // stored (spec `trusted-by-default-flip` §4).
    ...(request.permissionCeiling !== undefined
      ? { permissionCeiling: request.permissionCeiling }
      : {}),
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
      if (shouldCancelUnstartedRoomReply(outcome, ownTurn.startSeq)) collecting.cancel();
    },
    onError: (err) => {
      logger.warn('[rooms] triggered turn errored', {
        sessionId,
        roomId: request.room.id,
        error: err instanceof Error ? err.message : String(err),
      });
    },
  };
  // Capture copied DATA only for this constructor's actual current request.
  // Observation failure cannot replace the genuine dispatch or its cause.
  try {
    const observed = facet.originalCompletions.get(facet.runner);
    if (
      observed?.request === request &&
      readOriginalSessionRoomRunner(facet.runner) &&
      readOriginalRoomDispatchRequest(request, facet.runner) &&
      readOriginalRoomRequestCurrent(request, facet.runner)
    ) {
      const settings = Object.freeze({ ...seed });
      observed.defaults.value = Object.freeze({
        settings,
        whenBusy: dispatchOpts.whenBusy,
        ...(dispatchOpts.permissionCeiling !== undefined
          ? {
              permissionCeiling: copyOriginalRoomPermissionCeiling(dispatchOpts.permissionCeiling),
            }
          : {}),
        ...(unattendedMode !== undefined ? { newSessionPermissionMode: unattendedMode } : {}),
      });
      observeBeforeDispatch?.(request.entry.id);
    }
  } catch {
    // Passive DATA capture does not change turn behavior.
  }
  const result = await dispatchOriginalRoomMessage(request, facet.runner, dispatchOpts).catch(
    async (err: unknown) => {
      // A launch that recorded this minted id and then produced no turn:
      // nothing will ever bind that id, so its row is taken back rather than
      // left as a ghost (the case the late write was once moved for).
      // A refusing launch may reject without onSettled. Only a launch
      // without an actual turn_start can cancel/retire its collector and
      // roll back its minted row. A started turn keeps its real terminal path.
      if (ownTurn.startSeq === null) {
        try {
          collecting.cancel();
        } catch {
          // The original launch rejection remains first, including undefined.
        }
        forgetTurnRuntime();
        try {
          await forgetLaunchRow();
        } catch {
          // A failed rollback must not replace the original launch rejection.
        }
      }
      throw err;
    }
  );

  if (!result.accepted) {
    // Two ways to get here. The session's lock is held by somebody else,
    // decided BEFORE the launch step runs, so no row was written. Or the
    // agent's runtime HELD the launch (DOR-2065): answering would restart
    // the agent and end background work it is still running, and that is
    // decided AFTER the launch step, so a row may have been written. Both
    // take the row back here, so a refused launch leaves nothing behind.
    await forgetLaunchRow();
    // Either way the agent is busy with something that is not this room:
    // the operator typing into the very agent the room just addressed, or
    // that agent's own background work. Not running NOW is right: a second
    // turn queued inside the session would answer a room message with
    // whatever context it leaves behind. The dispatcher puts the message
    // back in line and tries again on a backoff (DOR-2823), and says so
    // once, because a dropped trigger nobody mentions looks exactly like a
    // broken agent (DOR-621).
    collecting.cancel();
    logger.info('[rooms] skipped a trigger: the session is busy', {
      sessionId,
      roomId: request.room.id,
    });
    return { sessionId, text: null, unanswered: 'busy' };
  }

  // Do not replace a later observed rename with the admission response's
  // earlier id. Without a rekey, retain the original accepted-id behavior.
  if (canonicalId === sessionId) canonicalId = result.canonicalId ?? sessionId;
  // The runtime renamed the session, so the stop path has a second name to
  // find this turn under: the room asks with the placeholder until
  // `rebindRoomSession` runs and with the canonical id afterwards, and a
  // late halt arrives on the far side of that switch. Same entry, both keys,
  // dropped together (DOR-1721).
  if (
    canonicalId !== sessionId &&
    (facet.stopState.current(sessionId) === inFlight ||
      facet.stopState.current(canonicalId) === inFlight)
  ) {
    facet.stopState.alias(canonicalId, inFlight);
    aliasTurnLevel(sessionId, canonicalId);
  }
  // **As early as admission knows it, and before the answer is collected.** The
  // room bound a `(room, agent)` session before the claim, but on a first
  // turn that id is a placeholder the runtime renames mid-flight — so a tool
  // post that read the binding would stamp an id nothing writes to again
  // (spec `tool-only-room-replies` §D8). Reported here, so almost every tool
  // call inside the turn sees the real one.
  request.onSessionBound(canonicalId);

  // Final ownership follows actual collector completion, when even a late
  // native rename is known. The turn started, so the session is real.
  // The registry binds a session that has no runtime yet and leaves a bound
  // one untouched, so a resumed session is a no-op.
  //
  // The origin is the whole of what this call says about power: a room,
  // and who wrote the message that started the turn (DOR-2105). Nobody is
  // watching a room turn, which is why it FOLLOWS the operator's level
  // rather than being denied it (DOR-1917) — and a message bridged in from
  // off this machine does not, because the binding it came from carries its
  // own grant (DOR-604). Neither rule is stated here: the mapping in
  // `session/origin/turn-origin.ts` is where both are written down, once.
  //
  // **A room seeds a row it MINTS and nothing else**, which is the other
  // half the mapping holds (`configured-stop-on-insert`). A row that
  // already exists belongs to a conversation somebody has already
  // configured, and ADR 260908-170643 promises it is untouched. That used
  // to be this file's `isNewSession` check guarding the argument; it is now
  // a property of the origin, so it cannot be lost by a caller forgetting
  // to ask.
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
  // So the invariant this bookkeeping protects is the dispatcher's, not its own: a
  // throw out of `run` must mean NOTHING RAN. Nothing that happens after the
  // model has spoken may throw past here. What is lost when this fails is one
  // runtime-attribution row, which the next turn on this session rewrites.
  const reply = await collecting.beforeDeadline;
  if (!reply) {
    // The room stops WAITING here; the turn keeps running. Its answer is
    // posted when it lands, carrying how long it took.
    logger.info('[rooms] still working past the wait deadline; the answer will post late', {
      sessionId: canonicalId,
      roomId: request.room.id,
    });
    return {
      sessionId: canonicalId,
      text: null,
      late: collecting.afterDeadline,
    };
  }

  await attributedCompletion;
  return {
    sessionId: canonicalId,
    text: reply.text,
    ...(reply.failed ? { unanswered: 'failed' as const } : {}),
  };
}
