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
import type { RoomTurnRequest, RoomTurnResult, RoomTurnRunner } from './room-trigger.js';

/**
 * Lock identity every room-triggered turn takes. One id, not one per turn: the
 * session write-lock is per session and a room binds one session per agent, so
 * two turns for the same agent in the same room are the same writer and the
 * second must queue rather than be refused as a foreign client.
 */
const ROOM_CLIENT_ID = 'dorkos-room';

/**
 * How long to wait for a triggered turn to finish before giving up on its reply.
 *
 * The turn itself is NOT cancelled — it keeps running and keeps streaming to its
 * own session — this only bounds how long the room waits to hear about it. A
 * turn that outruns this posts nothing, which is the honest outcome: a reply
 * arriving in a room twenty minutes after the message it answers is worse than
 * no reply.
 */
const ROOM_TURN_TIMEOUT_MS = 10 * 60_000;

/**
 * Build the runner that turns a room trigger into a real session turn.
 *
 * @returns A {@link RoomTurnRunner} bound to the process runtime registry.
 */
export function createSessionRoomTurnRunner(): RoomTurnRunner {
  return {
    async run(request: RoomTurnRequest): Promise<RoomTurnResult> {
      const sessionId = request.sessionId ?? randomUUID();
      const runtimeType = await resolveRuntimeType(request.agentPath);
      await runtimeRegistry.persistSessionRuntime(sessionId, runtimeType, request.agentPath);
      const runtime = await runtimeRegistry.resolveForSession(sessionId);

      const projector = getOrCreateProjector(sessionId, request.agentPath, {
        persist: runtime.getCapabilities().logBackedHistory === true,
      });
      projector.cwd = request.agentPath;

      // Take the cursor BEFORE triggering. Everything the turn emits has a seq
      // above it, so the collector cannot miss the opening of a fast turn.
      const collecting = collectReply(projector, projector.getCursor());

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

      if (!result.accepted) {
        // Somebody else is writing to this session — the operator, most likely,
        // typing into the very agent the room just addressed. Skipping is right:
        // queueing a second turn behind theirs would answer a room message with
        // whatever context their turn leaves behind.
        collecting.cancel();
        logger.info('[rooms] skipped a trigger: the session is busy', {
          sessionId,
          roomId: request.room.id,
        });
        return { sessionId, text: null };
      }

      return { sessionId: result.canonicalId ?? sessionId, text: await collecting.text };
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

/** What a subscription to one turn's output is collecting. */
interface ReplyCollector {
  /** Resolves with the agent's text once the turn closes, or `null` if it said nothing. */
  text: Promise<string | null>;
  /** Stop collecting — the turn never started. */
  cancel(): void;
}

/**
 * Accumulate a turn's assistant text from the session's own event stream.
 *
 * Reads `text_delta` and stops at the first `turn_end`, which is the same
 * boundary a client renders against, so a room shows exactly the answer the
 * session shows. Bounded by {@link ROOM_TURN_TIMEOUT_MS} and by an abort, so a
 * runtime that never closes its turn cannot pin this subscription forever.
 *
 * @param projector - The session projector to read.
 * @param sinceCursor - The seq to resume from — taken before the turn starts.
 */
function collectReply(projector: SessionStateProjector, sinceCursor: number): ReplyCollector {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ROOM_TURN_TIMEOUT_MS);
  // `unref` so a pending room turn never holds the process open on shutdown.
  timer.unref?.();

  const text = (async () => {
    let collected = '';
    try {
      for await (const event of projector.subscribe(sinceCursor, abort.signal)) {
        if (event.type === 'text_delta') collected += event.text;
        if (event.type === 'turn_end') break;
      }
    } finally {
      clearTimeout(timer);
    }
    return collected.trim() === '' ? null : collected;
  })();

  return {
    text,
    cancel: () => {
      abort.abort();
      clearTimeout(timer);
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
