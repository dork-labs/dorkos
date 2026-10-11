import { readOriginalClaudeNativePreparationView } from '../claude-code-runtime.js';
import type { OriginalClaudeNativeInstallation } from '../custody/claude-native-preparation-contracts.js';
import { readOriginalRoomDispatchLifecycle } from '../../../session/trigger-turn.js';
import type { OriginalRoomDispatchCustody } from '../../../rooms/service/room-core.js';
import { isCurrentClaudeNativeSession } from '../sessions/session-store.js';
import type { SseResponse } from '@dorkos/shared/agent-runtime';
import type { NativeSessionAcquisition } from '../../../session/session-lock.js';
import type { AgentSession } from '../agent-types.js';
import { ClaudeConnectorTurnContext } from '../connector-turn-context.js';

/** Execute the original installNativeTurn body only for its constructor-private runtime key. */
export function installNativeTurn(
  ownerKey: object,
  sessionId: string,
  session: AgentSession,
  cwdKey: string,
  agentPath: string | undefined,
  meshAgent: { id: string } | undefined,
  acquisition?: NativeSessionAcquisition,
  refuseExisting = false,
  roomOrigin?: Readonly<{ holder: SseResponse; custody: OriginalRoomDispatchCustody }>,
  relayOwner?: { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown }
): OriginalClaudeNativeInstallation {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const relayOwned = facet.relayPreparing.get(sessionId);
  if (relayOwned && (relayOwned !== relayOwner || relayOwned.retired))
    throw new Error('Original Relay session owner remains unresolved');
  if (
    roomOrigin &&
    readOriginalRoomDispatchLifecycle(roomOrigin.holder, facet.runtime) !== roomOrigin.custody
  )
    throw new Error('Original Room dispatch lifetime is retired.');
  const store = facet.claudeOriginalStores.get(facet.runtime),
    slot = Object.getOwnPropertyDescriptor(facet.runtime, 'sessionStore');
  if (
    !store ||
    !slot ||
    !('value' in slot) ||
    slot.value !== store ||
    !isCurrentClaudeNativeSession(store, session)
  )
    throw new Error('Native preparation requires its original session store.');
  const dedicated = facet.claudeRoomQuerySessions.get(session);
  if (dedicated && !dedicated.finished)
    throw new Error('A prepared Room session cannot be replaced while its continuation is live.');
  if (dedicated) facet.claudeRoomQuerySessions.delete(session);
  const existing = facet.claudeRuntimeEntries.get(facet.runtime)?.get(sessionId);
  if (refuseExisting && existing && !existing.retired)
    throw new Error('Native preparation cannot replace a live entry.');
  const nativeOperation = Object.freeze({});
  if (!facet.claudeNativeConstructors.has(facet.runtime))
    throw new Error('Native runtime operation requires its genuine constructor.');
  const nativeEntry = {
    roomOrigin,
    acquisition,
    instance: facet.runtime,
    session,
    store,
    retired: false,
    runtime: 'claude-code' as const,
    key: sessionId,
    agentPath,
    cwd: cwdKey,
    context: undefined as ClaudeConnectorTurnContext | undefined,
  };
  facet.claudeNativeOperations.set(nativeOperation, nativeEntry);
  facet.claudeOriginalSessionOperations.set(session, nativeOperation);
  let runtimeEntries = facet.claudeRuntimeEntries.get(facet.runtime);
  if (!runtimeEntries) {
    runtimeEntries = new Map();
    facet.claudeRuntimeEntries.set(facet.runtime, runtimeEntries);
  }
  runtimeEntries.set(sessionId, nativeEntry);
  const connectorTurn =
    facet.connectorRuntimeTools && meshAgent && agentPath
      ? new ClaudeConnectorTurnContext({
          tools: facet.connectorRuntimeTools,
          canonicalSessionId: () => session.sdkSessionId || sessionId,
          agentPath,
          cwd: cwdKey,
          nativeOperation,
          retireNative: () => {
            nativeEntry.retired = true;
          },
        })
      : undefined;
  nativeEntry.context = connectorTurn;
  return { nativeOperation, nativeEntry, runtimeEntries, connectorTurn };
}
