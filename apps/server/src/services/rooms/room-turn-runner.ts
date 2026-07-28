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
import { logger } from '../../lib/logger.js';
import { runtimeRegistry } from '../core/runtime-registry.js';
import {
  getOrCreateProjector,
  rekeyProjector,
  triggerTurn,
  type SessionStateProjector,
} from '../session/index.js';
import type {
  LateRoomReply,
  RoomTurnRequest,
  RoomTurnResult,
  RoomTurnRunner,
} from './room-trigger.js';

/**
 * Lock identity every room-triggered turn takes. One id, not one per turn: the
 * session write-lock is per session and a room binds one session per agent, so
 * two turns for the same agent in the same room are the same writer and the
 * second must queue rather than be refused as a foreign client.
 */
const ROOM_CLIENT_ID = 'dorkos-room';

/**
 * How long the room waits to hear about a triggered turn before moving on.
 *
 * This bounds the WAIT, not the turn. The turn itself is never cancelled: it
 * keeps running and keeps streaming to its own session, and when it finally
 * closes its answer is posted into the room with the delay said out loud (the
 * late-answer note in `room-notices.ts`). An earlier revision dropped it at this
 * deadline on the theory that a very late reply is worse than none — which gets
 * the trade backwards. Silence is the worse failure, and a person who waited
 * ten minutes for an answer deserves it more than the room deserves to be tidy.
 */
const ROOM_REPLY_WAIT_MS = 10 * 60_000;

/**
 * The hard stop on a turn the room is still holding a subscription for.
 *
 * The stall watchdog inside `triggerTurn` already ends any turn whose runtime
 * goes quiet, so reaching this means a turn that is producing events and never
 * closing. At that point the room stops listening and says the turn failed,
 * which is true, rather than holding one live subscription per trigger forever.
 */
const ROOM_LATE_REPLY_CEILING_MS = 60 * 60_000;

/** Knobs a caller can move; both default to the constants above. */
export interface RoomTurnRunnerOptions {
  /** How long the room waits for the answer before continuing without it. */
  waitMs?: number;
  /** How long the late collector keeps listening before giving the turn up. */
  ceilingMs?: number;
}

/**
 * Build the runner that turns a room trigger into a real session turn.
 *
 * @param options - Wait deadline and late-collector ceiling; defaults ship.
 * @returns A {@link RoomTurnRunner} bound to the process runtime registry.
 */
export function createSessionRoomTurnRunner(options: RoomTurnRunnerOptions = {}): RoomTurnRunner {
  const waitMs = options.waitMs ?? ROOM_REPLY_WAIT_MS;
  const ceilingMs = options.ceilingMs ?? ROOM_LATE_REPLY_CEILING_MS;
  return {
    async run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      const sessionId = request.sessionId ?? randomUUID();
      const runtimeType = await resolveRuntimeType(request.agentPath);
      // Resolve the runtime WITHOUT writing anything. `persistSessionRuntime`
      // used to run here, before the turn was known to have started, so a
      // runtime that reliably throws left one orphan `session_metadata` row (and
      // one projector) per room message: `bindRoomSession` is never reached, the
      // next trigger mints a fresh UUID, and the dead row stays forever. The
      // registry's own docs warn about exactly this ghost-row shape.
      const runtime = runtimeRegistry.get(runtimeType);
      if (!runtime) throw new Error(`Runtime '${runtimeType}' is not registered`);

      const projector = getOrCreateProjector(sessionId, request.agentPath, {
        persist: runtime.getCapabilities().logBackedHistory === true,
      });
      projector.cwd = request.agentPath;

      // Take the cursor BEFORE triggering. Everything the turn emits has a seq
      // above it, so the collector cannot miss the opening of a fast turn.
      const collecting = collectReply(projector, projector.getCursor(), { waitMs, ceilingMs });

      const result = await triggerTurn({
        sessionId,
        clientId: ROOM_CLIENT_ID,
        content: composeRoomPrompt(request),
        cwd: request.agentPath,
        projector,
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

      // The turn started, so the session is real: record which runtime owns it.
      // INSERT-OR-IGNORE at the registry, so a resumed session is a no-op.
      if (result.accepted) {
        await runtimeRegistry.persistSessionRuntime(
          result.canonicalId ?? sessionId,
          runtimeType,
          request.agentPath
        );
      }

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
  };
}

/**
 * The message an agent actually receives.
 *
 * Written as prose a person would recognise, because it is prose an agent
 * reads: it says which room this is, who spoke, and — the part that changes
 * behavior — that the answer is posted back for everyone in the room, not
 * returned privately to whoever asked.
 *
 * @param request - The room, the agent, and the entry that triggered it.
 */
export function composeRoomPrompt(request: RoomTurnRequest): string {
  const where = request.room.slug ? `#${request.room.slug}` : request.room.title;
  return [
    `New message in ${where} from ${request.authorName}:`,
    '',
    request.entry.body.text,
    '',
    `Reply as you would in a chat room. Your answer is posted into ${where}, where everyone in the room reads it.`,
  ].join('\n');
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
 * Accumulate a turn's assistant text from the session's own event stream.
 *
 * Reads `text_delta` and stops at the first `turn_end`, which is the same
 * boundary a client renders against, so a room shows exactly the answer the
 * session shows. `turn_end` also carries `terminalReason`, which is how a turn
 * that failed is told from one that simply had nothing to say — the two used to
 * be the same `null` here, and the room reported neither.
 *
 * ONE subscription serves both phases. The deadline resolves a race, it does
 * not abort the read: aborting at the deadline is what made a slow turn post
 * either nothing or a half-finished fragment of whatever it had streamed so far.
 *
 * @param projector - The session projector to read.
 * @param sinceCursor - The seq to resume from — taken before the turn starts.
 * @param bounds.waitMs - How long the room waits before moving on.
 * @param bounds.ceilingMs - When to give up on a turn that never closes.
 */
function collectReply(
  projector: SessionStateProjector,
  sinceCursor: number,
  bounds: { waitMs: number; ceilingMs: number }
): ReplyCollector {
  const abort = new AbortController();
  const startedAt = Date.now();
  const ceiling = setTimeout(() => abort.abort(), bounds.ceilingMs);
  // `unref` so a pending room turn never holds the process open on shutdown.
  ceiling.unref?.();

  // Never rejects: both phases read this one promise, and the busy path reads
  // neither, so a rejection would surface as an unhandled one.
  const closed: Promise<CollectedTurn> = (async () => {
    let collected = '';
    let ended = false;
    let failed = false;
    try {
      for await (const event of projector.subscribe(sinceCursor, abort.signal)) {
        if (event.type === 'text_delta') collected += event.text;
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
    }
    return {
      text: collected.trim() === '' ? null : collected,
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
 * @param agentPath - The agent's project directory.
 */
async function resolveRuntimeType(agentPath: string): Promise<string> {
  try {
    const manifest = await readManifest(agentPath);
    if (manifest?.runtime && runtimeRegistry.has(manifest.runtime)) return manifest.runtime;
  } catch {
    // No manifest, or an unreadable one. The default is the right answer.
  }
  return runtimeRegistry.getDefaultType();
}
