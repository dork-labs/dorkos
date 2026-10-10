/**
 * Ending Claude Code sessions outright: a pause that stops every live session
 * of an agent (spec `audit-trail` PR5), and an unlink that stops every session
 * running on DorkOS credits (ADR 261001-000811). Both interrupt the turn and
 * evict the process, background work and wake-up timers included. Also the
 * health sweep that evicts stale sessions and gives back what they held.
 *
 * @module services/runtimes/claude-code/end-sessions
 */
import {
  picksSession,
  type InterruptReceipt,
  type LiveSessionRef,
} from '@dorkos/shared/agent-runtime';
import { logger } from '../../../lib/logger.js';
import { editBaselineStore } from '../../diff/index.js';
import { disposeProjector, peekProjector } from '../../session/index.js';
import type { SessionLockManager } from '../../session/session-lock.js';
import { isCreditsClaudeRoot } from './credits-root.js';
import type { PluginReloadScheduler } from './messaging/plugin-reload-policy.js';
import type { SessionStore } from './sessions/session-store.js';
import type { SessionPumpRegistry } from './sessions/session-pump-registry.js';
import type { PersistentDispatch } from './sessions/persistent-dispatch.js';

/** What ending a session needs from `ClaudeCodeRuntime`. */
export interface SessionEndingPort {
  /** Every session this process has run. */
  readonly sessionStore: Pick<
    SessionStore,
    'sessionIdsWhere' | 'findSession' | 'checkSessionHealth'
  >;
  /** The warm processes. */
  readonly pumps: Pick<SessionPumpRegistry, 'warmth' | 'evict' | 'peek'>;
  /** The persistent-dispatch wiring, forgotten with the process. */
  readonly persistent: Pick<PersistentDispatch, 'forget' | 'bootingQuery' | 'runtimeTurnQuery'>;
  /** The session locks the health check reads. */
  readonly lockManager: SessionLockManager;
  /** Plugin reloads held back, dropped with an evicted session. */
  readonly pluginReloads: Pick<PluginReloadScheduler, 'cancel'>;
  /** Interrupt the session's turn. */
  interruptQuery(sessionId: string): Promise<InterruptReceipt>;
  /** The folder the session runs in, when known. */
  getSessionCwd(sessionId: string): string | undefined;
}

/**
 * Whether anything of this session could still act: a running turn, a warm
 * or booting process, or a turn the agent opened. A cold session with none is
 * skipped by {@link endSessionsWhere}, so a pause never pays for the rest.
 *
 * @param port - The runtime's session wiring.
 * @param sessionId - The session.
 */
function isLive(port: SessionEndingPort, sessionId: string): boolean {
  return (
    port.sessionStore.findSession(sessionId)?.activeQuery !== undefined ||
    port.pumps.warmth(sessionId) !== 'cold' ||
    port.persistent.bootingQuery(sessionId) !== undefined ||
    port.persistent.runtimeTurnQuery(sessionId) !== undefined
  );
}

/**
 * Interrupt a session's turn and evict its process, background work and
 * wake-up timers included. Evicted, not reaped: a polite reap declines a
 * process still holding background work, and a stop must not stay undone for
 * hours behind a running shell (DOR-2065).
 *
 * @param port - The runtime's session wiring.
 * @param id - The session.
 * @returns Whether anything was running that this stopped
 */
async function endSession(port: SessionEndingPort, id: string): Promise<boolean> {
  const wasWarm = port.pumps.warmth(id) !== 'cold';
  const receipt = await port.interruptQuery(id).catch(() => undefined);
  port.persistent.forget(id);
  await port.pumps.evict(id).catch(() => undefined);
  const stopped = receipt?.outcome === 'acked' || receipt?.outcome === 'closed';
  return stopped || (wasWarm && port.pumps.warmth(id) === 'cold');
}

/**
 * End every live session `belongs` picks. Asks the session store, which holds
 * every session this process has run, and skips the cold ones with nothing
 * running. Each live one is ended, all at once.
 *
 * @param port - The runtime's session wiring.
 * @param belongs - Picks the sessions to end.
 * @returns The ids of the sessions this stopped something in
 */
export async function endSessionsWhere(
  port: SessionEndingPort,
  belongs: (session: LiveSessionRef) => boolean
): Promise<string[]> {
  const ids = port.sessionStore
    .sessionIdsWhere(() => true)
    .filter((sessionId) => isLive(port, sessionId))
    .filter((sessionId) =>
      picksSession(belongs, { sessionId, cwd: port.getSessionCwd(sessionId) })
    );
  const results = await Promise.all(ids.map(async (id) => [id, await endSession(port, id)]));
  return results.filter(([, ended]) => ended).map(([id]) => id as string);
}

/**
 * End every session running on DorkOS credits, one after another.
 *
 * @param port - The runtime's session wiring.
 */
export async function stopCreditsSessions(port: SessionEndingPort): Promise<void> {
  const ids = port.sessionStore.sessionIdsWhere((session) => {
    const root = session.launchedAccountRoot ?? session.accountRoot;
    return root !== undefined && isCreditsClaudeRoot(root);
  });
  for (const id of ids) await endSession(port, id);
}

/**
 * Evict every session the store's health check finds stale, and give back
 * everything it held: its process, a held plugin reload, its diff baselines
 * and its stream projector. Synchronous by contract (the runtime's
 * `checkSessionHealth`).
 *
 * @param port - The runtime's session wiring.
 */
export function sweepEvictedSessions(port: SessionEndingPort): void {
  // Drop the projector of every evicted session (I1 fix — the registry Map
  // otherwise grows per session id forever). The store returns each evicted
  // session's request UUID AND its canonical sdkSessionId: rekeyProjector
  // moves a brand-new session's projector to the canonical id mid-first-turn,
  // so disposing by the map key alone would miss every rekeyed projector and
  // leak it (plus its EventLog). A session evicted MID-TURN is first marked
  // `interrupted` so any client still on its `/events` stream sees the turn
  // close (lifecycle `interrupted`) rather than a frozen "Thinking…" before
  // the projector is disposed (ADR-0262/0264 restart/eviction degradation).
  // markInterrupted is a no-op for an idle projector.
  // A session whose warm process is still doing background work is skipped
  // for now: eviction is unconditional, so it would end a helper agent or an
  // undelivered notification that the idle reaper already refuses to touch
  // (spec `warm-process-lifecycle` D1). The pump answers, because the pump is
  // what holds the level frame; a session with no warm process holds nothing
  // and evicts exactly as it did before.
  const evictedIds = port.sessionStore.checkSessionHealth(
    port.lockManager,
    (sessionId) => port.pumps.peek(sessionId)?.isHoldingWork() === true
  );
  for (const sessionId of evictedIds) {
    // No subprocess may outlive the session record it belongs to. Eviction
    // ALWAYS implies a reap; the idle timer's reap never implies an eviction
    // (spec §4.3). Not awaited, because this sweep is synchronous by contract
    // and a close that takes its grace window must not hold it up — and never
    // bare `void`, because a wedged teardown rejecting would take the server
    // down with it. A no-op for a session that never opted in: nothing warms a
    // pump unless `runtimes.claudeCode.persistentSession` is on — not a turn,
    // and not a staged message either, which is what DOR-1307 restored.
    //
    // The wiring is forgotten alongside the process, so a session that comes
    // back builds a fresh pump rather than dispatching into a spent one. Done
    // FIRST and synchronously: the teardown below is awaited by nobody, and a
    // message arriving in that window must not find a bundle whose pump is
    // already on its way out.
    port.persistent.forget(sessionId);
    // A reload waiting for this session's cache to go cold has nothing left to
    // apply: the process is going, and the next launch reads the plugin set
    // off disk. Dropped rather than paid — nothing was spent, so nothing is
    // recorded (spec `plugin-reload-cache-cost`).
    port.pluginReloads.cancel(sessionId);
    port.pumps.evict(sessionId).catch((err: unknown) => {
      logger.warn('[ClaudeCodeRuntime] evicted session failed to give back its process', {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    // Drop the session's captured diff baselines (DOR-212) — they are in-memory
    // and per-session, so an evicted session must not leak them. Idempotent for
    // an id that captured none.
    editBaselineStore.clearSession(sessionId);
    const projector = peekProjector(sessionId);
    if (!projector) continue;
    projector.markInterrupted();
    disposeProjector(sessionId);
  }
}
