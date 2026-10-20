/**
 * Read-only questions the dispatcher asks about a session: is its turn still
 * producing, is a turn open, does a refusing caller refuse it, is any turn in
 * flight, and the steerable announcement every ingress makes first.
 *
 * @module services/session/message-dispatcher/turn-probes
 */
import type { AgentRuntime } from '@dorkos/shared/agent-runtime';
import type { SessionEvent } from '@dorkos/shared/session-stream';
import type { SessionStateProjector } from '../session-state-projector.js';
import { primaryOf, projectorFor } from '../resolution/session-key-registry.js';
import { inFlight } from './state.js';
import type { DispatchMessageOpts, InFlightTurn, WhenBusy } from './types.js';

/**
 * The `status_change` member as an emitter builds it — the projector stamps the
 * `seq`, exactly as it does for the queue's own events (`queue-stream-events.ts`).
 */
export type RawStatusChange = Omit<Extract<SessionEvent, { type: 'status_change' }>, 'seq'>;

/**
 * Publish whether this session can be STEERED, so a composer offers a cut-in
 * only when one could really happen (DOR-1268).
 *
 * `supportsSteer` is a per-RUNTIME declaration and cannot answer this: claude-code
 * steers through a held process, so a session on the resume path — how a default
 * install ships — is not steerable however capable the adapter is. The runtime
 * answers for the session ({@link AgentRuntime.canSteerSession}); a runtime whose
 * steering is uniform omits the method and its static flag stands.
 *
 * Announced HERE, on the one ingress every turn passes through, and only when
 * the answer CHANGED — so the value is current before any turn a person could
 * steer is open, it costs one event per session rather than one per message, and
 * an operator flipping the persistent-session setting reaches every open window
 * on the session's next message rather than only on its next reload.
 *
 * A no-op when the answer is unchanged; a cold connect reads the value out of
 * the projector's held status either way.
 *
 * @param opts - Whatever a caller of this module already holds: the session, its
 *   projector and its runtime. Both ingresses qualify.
 * @param sessionKey - The id the session's projector is filed under
 */
export function announceSteerable(
  opts: Pick<DispatchMessageOpts, 'sessionId' | 'projector' | 'runtime'>,
  sessionKey: string
): void {
  const { runtime } = opts;
  const steerable =
    runtime.canSteerSession?.(opts.sessionId) ?? runtime.getCapabilities().supportsSteer;
  const projector = projectorFor(sessionKey) ?? opts.projector;
  if (projector.getStatus().steerable === steerable) return;
  const event: RawStatusChange = { type: 'status_change', status: { steerable } };
  projector.ingest(event);
}

/**
 * Whether the turn holding the in-flight slot is STILL PRODUCING — the question
 * a refusal is really asking (DOR-1239).
 *
 * The slot answers a different question: "has the stream closed and been handed
 * back". Those two moments are not the same one. A runtime keeps its stream open
 * past the end of the turn to drain background work — claude-code's subprocess
 * stays alive after `done` precisely so a finished task can wake the agent again
 * (`session-event-normalizer.ts`) — and the write-lock is released on the same
 * late signal, so asking the REAL lock instead would give the same wrong answer.
 * Through that whole window the agent has stopped: the projector has already been
 * told `turn_end`, every window draws the session as idle, and a widget button
 * rendered in the reply is on screen and clickable. A click there was answered
 * `409 SESSION_LOCKED` over a session nothing was using.
 *
 * So the projector is the authority once the turn has reached it: its in-progress
 * turn opens at `turn_start` and closes at `turn_end`, which is exactly "the
 * agent is producing". It re-opens on its own if the agent wakes itself up
 * (DOR-1100), so a session that starts producing again refuses again without
 * this needing to know that happened.
 *
 * **What accepting here does NOT promise is adjacency.** The message runs when
 * the slot clears, and one turn at a time still holds — but a self-woken window
 * (DOR-1100) can open and close inside that same stream, so the accepted message
 * can land after a window the person never asked for, rather than immediately
 * after the turn it was clicked in. That is measured behavior, not a hypothesis.
 * It is still the better answer than a hard refusal: the alternative was 409 over
 * a session nothing was using, and every ordering guarantee is unchanged.
 *
 * @param open - The turn holding the session's in-flight slot.
 * @param sessionKey - The id that turn's dispatcher state is filed under.
 * @param fallback - The caller's projector, used when the registry has none.
 * @returns True while the turn is producing; false in the post-`turn_end` drain.
 */
export function isStillProducing(
  open: InFlightTurn,
  sessionKey: string,
  fallback: SessionStateProjector
): boolean {
  if (!open.sawTurnStart) return true;
  return hasOpenTurn(sessionKey, fallback);
}

/**
 * Whether a turn is open on this session RIGHT NOW, asked of the session's own
 * projection rather than of the dispatcher's bookkeeping.
 *
 * Reads the REGISTRY's projector — the one the pump's own gate reads and the one
 * a turn ingests into, whichever id the caller happens to hold — and falls back
 * to the caller's only when the session is not registered.
 *
 * @param sessionKey - The id the session's projector is filed under.
 * @param fallback - The caller's projector, for a session the registry has none for.
 */
export function hasOpenTurn(sessionKey: string, fallback: SessionStateProjector): boolean {
  return (projectorFor(sessionKey) ?? fallback).peekInProgressTurn() !== null;
}

/**
 * Whether the turn that is open right now is one this caller refuses to wait
 * behind.
 *
 * Two questions, and a refusal needs both to be yes. Is the session still
 * PRODUCING ({@link isStillProducing}) — a turn that has ended is not something
 * to refuse over, whoever it belonged to. And is it a turn this caller refuses to
 * wait behind, which is where the whole difference between the two refusing modes
 * lives: a question about WHOSE turn is open rather than about whether one is.
 * See {@link WhenBusy} for why a caller that sequences its own turns — a room —
 * must not be told its own tail is a stranger.
 *
 * @param opts.whenBusy - What the caller asked for.
 * @param opts.open - The turn holding the session's in-flight slot, if any.
 * @param opts.clientId - The caller's lock identity.
 * @param opts.sessionKey - The id the session's dispatcher state is filed under.
 * @param opts.projector - The caller's projector, for the producing probe.
 * @returns True when this message should be refused rather than accepted.
 */
export function refusesOpenTurn(opts: {
  whenBusy: WhenBusy;
  open: InFlightTurn | undefined;
  clientId: string;
  sessionKey: string;
  projector: SessionStateProjector;
}): boolean {
  const { whenBusy, open, clientId } = opts;
  if (open === undefined || whenBusy === 'queue') return false;
  if (!isStillProducing(open, opts.sessionKey, opts.projector)) return false;
  return whenBusy === 'refuse' || open.clientId !== clientId;
}

/**
 * Whether a turn is running on this session right now, by every authority
 * that can know (spec `agent-home-desk` §6.1).
 *
 * True when ANY of three says so: the dispatcher's in-flight slot, the
 * runtime's real write lock, or the session's projector holding an open turn.
 * The slot alone is lossy — a turn launched with its queue budget exhausted
 * runs holding the runtime lock and never takes the slot
 * ({@link launchDispatch}), the same hole {@link deliverSteer} closes by asking
 * the lock. A caller that must not act under a running turn (the room's
 * launch-time work on an agent's copy of a room's files) asks here.
 *
 * @param sessionId - The session, by any id it has held.
 * @param runtime - The runtime that session runs on.
 */
export function isTurnInFlight(
  sessionId: string,
  runtime: Pick<AgentRuntime, 'isLocked' | 'getInternalSessionId'>
): boolean {
  const lockKey = runtime.getInternalSessionId(sessionId) ?? sessionId;
  const sessionKey = primaryOf(lockKey);
  if (inFlight.has(sessionKey)) return true;
  if (runtime.isLocked(lockKey) || (lockKey !== sessionId && runtime.isLocked(sessionId))) {
    return true;
  }
  return (projectorFor(sessionKey)?.peekInProgressTurn() ?? null) !== null;
}
