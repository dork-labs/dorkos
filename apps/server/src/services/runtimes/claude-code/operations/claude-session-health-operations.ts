import { sweepEvictedSessions } from '../end-sessions.js';
import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { InterruptReceipt } from '@dorkos/shared/agent-runtime';

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

/** Evict stale sessions through the original root-guarded Main health sweep. */
export function checkSessionHealth(ownerKey: object): void {
  readOriginalClaudeNativePreparationView(ownerKey);
  sweepEvictedSessions(ownerKey);
}
