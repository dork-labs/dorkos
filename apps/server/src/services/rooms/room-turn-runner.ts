/**
 * The production {@link RoomTurnRunner}: a room post becomes a real agent turn.
 *
 * It is one file, separate from `room-trigger.ts`, so the cascade rules stay
 * testable without a runtime and this — the part that needs sessions, the
 * runtime registry and a lock — stays the only place that knows about them.
 *
 * Two decisions worth reading before changing anything here:
 *
 * - **The turn runs through {@link triggerTurn}, not the runtime directly.**
 *   Going straight to `runtime.sendMessage` would be shorter and would make the
 *   agent's work invisible: nothing would feed the per-session projector, so
 *   opening that session in the cockpit would show an empty transcript while
 *   the agent was mid-answer. Everything a room triggers is a normal session
 *   turn, visible on `GET /api/sessions/:id/events` like any other (ADR-0264).
 *
 * - **The reply is read off the projector, not the generator.** `triggerTurn`
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
import { readManifest } from '@dorkos/shared/manifest';
import {
  isBlockingInteractionEvent,
  type BlockingInteractionEventType,
} from '@dorkos/shared/session-stream';
import { logger } from '../../lib/logger.js';
import { projectRoomAttachments } from './attachments/attachment-projection.js';
import { getRoomAttachmentStore } from './index.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import {
  getOrCreateProjector,
  persistenceModeFor,
  rekeyProjector,
  readAgentExecutionDefaults,
  resolveSessionDefaults,
  triggerTurn,
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
 * Lock identity every room-triggered turn takes. One id, not one per turn: the
 * session write-lock is per session and a room binds one session per agent, so
 * two turns for the same agent in the same room are the same writer and the
 * second must queue rather than be refused as a foreign client.
 */
const ROOM_CLIENT_ID = 'dorkos-room';

/**
 * The two bounds on how long a room pays attention to one turn.
 *
 * **`waitMs` bounds the WAIT, not the turn.** The turn itself is never
 * cancelled: it keeps running and keeps streaming to its own session, and when
 * it finally closes its answer is posted into the room with the delay said out
 * loud (the late-answer note in `room-notices.ts`). An earlier revision dropped
 * it at this deadline on the theory that a very late reply is worse than none —
 * which gets the trade backwards. Silence is the worse failure, and a person who
 * waited ten minutes for an answer deserves it more than the room deserves to be
 * tidy.
 *
 * **`ceilingMs` is the hard stop on the subscription.** The stall watchdog
 * inside `triggerTurn` already ends any turn whose runtime goes quiet, so
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
}

/** The shipped wait, used when a caller supplies no reader. */
const DEFAULT_REPLY_WAIT_MS = 10 * 60_000;

/** The shipped ceiling, used when a caller supplies no reader. */
const DEFAULT_LATE_REPLY_CEILING_MS = 60 * 60_000;

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
  return {
    async run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      const sessionId = request.sessionId ?? randomUUID();
      const runtimeType = await resolveRoomRuntimeType(request.agentPath);
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
      const declared = runtime.getCapabilities().settings;
      const seed =
        (await runtimeRegistry.getSessionSettings(sessionId)) === null
          ? resolveSessionDefaults({
              runtimeType,
              // A room turn always has an agent — it is the agent the room
              // addressed — so this is the one surface where the per-agent
              // setting is the whole point rather than a refinement.
              agent: await readAgentExecutionDefaults(request.agentPath),
              configSection: declared.configSection,
              // The room's addressed agent can name an effort on any runtime,
              // including one that has none — this is what drops it there.
              supportsEffort: declared.supportsEffort,
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
      const projector = getOrCreateProjector(sessionId, request.agentPath, {
        persist: persistenceModeFor(runtime.getCapabilities()),
      });
      projector.cwd = request.agentPath;

      // Take the cursor BEFORE triggering. Everything the turn emits has a seq
      // above it, so the collector cannot miss the opening of a fast turn — and
      // which of the turns above it is OURS is settled by identity, not by the
      // cursor: `triggerTurn` reports the seq it stamps this turn's `turn_start`
      // with, and the collector reads for exactly that one.
      //
      // The prompt IS the message, byte for byte. Everything else the agent
      // needs to know — the room, the roster, who is a person, what it missed —
      // rides `additionalContext` (ADR-0273). This used to be prose wrapped
      // around the message, which put words nobody typed inside the visible user
      // turn and told the agent almost nothing.
      const prompt = request.entry.body.text;

      // Before the turn, never after: the context about to be handed to the
      // model names these files by relative path, so they have to be inside the
      // agent's working directory by the time it reads them (ADR 260807-233816).
      // It never throws — a missing file is survivable, a room that stopped
      // answering is not.
      await projectRoomAttachments({
        store: getRoomAttachmentStore,
        roomId: request.room.id,
        agentPath: request.agentPath,
        attachments: request.attachmentProjection,
      });

      const waitMs = readWaitMs();
      // The turn's identity, filled in by `triggerTurn` the instant this turn's
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
        graceMs: readGraceMs(),
      });

      const result = await triggerTurn({
        sessionId,
        clientId: ROOM_CLIENT_ID,
        content: prompt,
        cwd: request.agentPath,
        roomContext: request.roomContext,
        settings: seed,
        projector,
        onTurnStart: (seq) => {
          ownTurn.startSeq = seq;
        },
        deps: {
          acquireLock: (sid, cid, lifecycle, token) =>
            runtime.acquireLock(sid, cid, lifecycle, token),
          releaseLock: (sid, cid, token) => runtime.releaseLock(sid, cid, token),
          sendMessage: (sid, text, opts) => runtime.sendMessage(sid, text, opts),
          interruptQuery: (sid) => runtime.interruptQuery(sid),
          getInternalSessionId: (sid) => runtime.getInternalSessionId(sid),
          rekeyProjector: (oldId, newId) => rekeyProjector(oldId, newId),
          getCapabilities: () => runtime.getCapabilities(),
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
        // typing into the very agent the room just addressed. Skipping the turn
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

    async interrupt({ sessionId, agentPath }): Promise<void> {
      // The runtime is resolved from the AGENT, exactly as `run` resolves it,
      // rather than from the session's registry row: a first turn's row is
      // written after the turn starts, so a halt arriving early would otherwise
      // find nothing to stop.
      const runtime = runtimeRegistry.get(await resolveRoomRuntimeType(agentPath));
      if (!runtime) return;
      const stopped = await runtime.interruptQuery(sessionId);
      logger.info('[rooms] interrupted a turn', { sessionId, stopped });
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
 * spends only a tenth of the ten-minute auto-deny window
 * (`SESSIONS.INTERACTION_TIMEOUT_MS`), so a person reading the line still has
 * about nine minutes to act on it — the room is late to speak, never too late
 * to be useful.
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
 * @param bounds.graceMs - How long a prompt may stand before it is mentioned.
 */
function collectReply(
  projector: SessionStateProjector,
  sinceCursor: number,
  bounds: {
    waitMs: number;
    ceilingMs: number;
    ownTurn: OwnTurn;
    onWaiting: (waiting: RoomTurnWaiting) => void;
    graceMs: number;
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
        if (event.type === 'turn_end') {
          ended = true;
          failed = event.terminalReason === 'error';
          break;
        }
      }
    } catch (err) {
      logger.warn('[rooms] could not read a turn off its session stream', {
        sessionId: projector.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      failed = true;
    } finally {
      clearTimeout(ceiling);
      // The turn has ended, one way or another. A prompt it was stopped on can
      // no longer be answered, so a notice about it now would be advice nobody
      // can act on — and a timer outliving its turn is a room that speaks about
      // work that is over.
      stopWaitingOnEverything();
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

/**
 * Which runtime an agent's room turn should run on: its manifest's preference
 * when that runtime is registered in this process, otherwise the default.
 *
 * Mirrors `POST /api/sessions/:id/messages`, deliberately including the soft
 * fallback — a test-mode server registers only `test-mode` while every manifest
 * on disk says `claude-code`, and without the fallback no room could ever
 * trigger anything there.
 *
 * Exported because the binding repair sweep
 * (`room-session-convergence.ts`) has to ask the identical question — "which
 * runtime owns this room's session?" — and a second copy of the fallback is a
 * second copy that can disagree.
 *
 * @param agentPath - The agent's project directory.
 */
export async function resolveRoomRuntimeType(agentPath: string): Promise<string> {
  try {
    const manifest = await readManifest(agentPath);
    if (manifest?.runtime && runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
  } catch {
    // No manifest, or an unreadable one. The default is the right answer.
  }
  return runtimeRegistry.getDefaultType();
}
