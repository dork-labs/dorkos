import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { InterruptReceipt } from '@dorkos/shared/agent-runtime';
import { logger } from '../../../../lib/logger.js';
import { disposeProjector, peekProjector } from '../../../session/session-state-projector.js';
import { editBaselineStore } from '../../../diff/index.js';

/** Execute original interruptQuery behavior after actual runtime private-key admission. */
export async function interruptQuery(
  ownerKey: object,
  sessionId: string
): Promise<InterruptReceipt> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const pending = facet.roomPreparing.get(sessionId);
  if (pending) pending.retired = true;
  const nativeEntries = facet.claudeRuntimeEntries.get(facet.runtime);
  if (nativeEntries)
    for (const [key, entry] of nativeEntries) {
      const canonical = Object.getOwnPropertyDescriptor(entry.session, 'sdkSessionId');
      if (key === sessionId || (canonical && 'value' in canonical && canonical.value === sessionId))
        entry.retired = true;
    }
  const connectorCancellation = facet.sessionStore.findSession(sessionId)?.connectorTurn?.cancel();
  const receipt = await facet.sessionStore.interruptQuery(sessionId);
  await connectorCancellation;
  // A turn DorkOS is only HOLDING open, waiting for an answer the CLI may
  // still send (DOR-2064), has nothing left for an idle CLI to wind down: an
  // acknowledged interrupt produces no `result`, so the hold would run to its
  // 30 s cap and the Stop would look ignored. Settle it on the `result` it holds.
  if (receipt.outcome === 'acked') facet.persistent.settleHeldTurn(sessionId);
  // Only `not-running` falls through. A stop that reached a live query and
  // then failed is a fact about THAT query, and re-aiming it at the booting
  // one would report the second attempt's ending for the first attempt's turn.
  if (receipt.outcome !== 'not-running') return receipt;
  // Nothing on the ordinary path — but a persistent session's FIRST turn may
  // still be booting, so the pump holds a live query the `running` edge has
  // not yet armed `session.activeQuery` with (DOR-1191). Reach that turn
  // through the same interrupt→close escalation the running path uses.
  const bootingQuery = facet.persistent.bootingQuery(sessionId);
  if (bootingQuery !== undefined) {
    return facet.sessionStore.interruptGivenQuery(sessionId, bootingQuery);
  }
  // Or a turn the AGENT started, which never armed `session.activeQuery`
  // either: nobody dispatched it, so the pump's `running` edge never fired
  // (spec `warm-process-lifecycle` D6, the Stop rule). Without this, Stop on a
  // turn the person can plainly see answers "nothing is running".
  const runtimeQuery = facet.persistent.runtimeTurnQuery(sessionId);
  if (runtimeQuery === undefined) return receipt;
  return facet.sessionStore.interruptGivenQuery(sessionId, runtimeQuery);
}

/** Execute original checkSessionHealth behavior after actual runtime private-key admission. */
export function checkSessionHealth(ownerKey: object): void {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
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
  const evictedIds = facet.sessionStore.checkSessionHealth(
    facet.lockManager,
    (sessionId) => facet.pumps.peek(sessionId)?.isHoldingWork() === true
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
    facet.persistent.forget(sessionId);
    // A reload waiting for this session's cache to go cold has nothing left to
    // apply: the process is going, and the next launch reads the plugin set
    // off disk. Dropped rather than paid — nothing was spent, so nothing is
    // recorded (spec `plugin-reload-cache-cost`).
    facet.pluginReloads.cancel(sessionId);
    facet.pumps.evict(sessionId).catch((err: unknown) => {
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
