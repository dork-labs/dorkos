import {
  readOriginalClaudeNativePreparationView,
  readClaudeNativeOperation,
} from '../claude-code-runtime.js';
import type { ClaudeNativeEntry } from '../custody/claude-native-custody.js';
import type { OriginalDocumentProcessReservation } from '@dorkos/relay/server-private-document';
import {
  prepareOriginalRelaySdkLaunch,
  requireOriginalPreparedRelaySdkLaunch,
  retireOriginalPreparedRelaySdkLaunch,
  drainOriginalRelaySdkQuery,
  type OriginalPreparedRelaySdkLaunch,
} from '../messaging/relay/relay-sdk-launch.js';
import {
  claimOriginalPreparedRelayDocumentFacts,
  readOriginalFrozenRelayDocumentTarget,
  readOriginalFrozenRelayDocumentLaunchInput,
  reserveOriginalFrozenRelayDocumentProcess,
} from '../../../canvas/doc-channel/delivery/relay-authority.js';
import type {
  OriginalFrozenRelayDocumentSource,
  PreparedRelayDocumentResponder,
} from '../../../canvas/doc-channel/delivery/relay-native-types.js';
import { readOriginalPersistentRoomState } from '../sessions/persistent-dispatch.js';
import {
  captureNativeSessionActivity,
  readNativeSessionAcquisition,
  type NativeSessionAcquisition,
} from '../../../session/session-lock.js';
import { executeSdkQuery } from '../messaging/message-sender.js';
import { homeOf, resolveAgentHome } from '../../../core/agent-identity/index.js';
import {
  resolveOriginalClaudeConnectorPrincipal,
  ClaudeConnectorTurnContext,
} from '../connector-turn-context.js';

/** Execute the original prepareRelayDocument body only for its constructor-private runtime key. */
export async function prepareRelayDocument(
  ownerKey: object,
  source: OriginalFrozenRelayDocumentSource,
  target: Readonly<{ sessionId: string; agentPath: string; agentId: string }>,
  acquisition: NativeSessionAcquisition
): Promise<PreparedRelayDocumentResponder | undefined> {
  const facet = readOriginalClaudeNativePreparationView(ownerKey);
  const { sessionId, agentPath } = target,
    tools = facet.connectorRuntimeTools;
  if (
    !tools ||
    facet.relayPreparing.has(sessionId) ||
    facet.roomPreparing.has(sessionId) ||
    (facet.claudeRuntimeEntries.get(facet.runtime)?.get(sessionId) &&
      !facet.claudeRuntimeEntries.get(facet.runtime)!.get(sessionId)!.retired)
  )
    return undefined;
  const capacity = readOriginalPersistentRoomState(facet.persistent, sessionId);
  if (capacity === 'running' || capacity === 'warming' || capacity === 'resuming') return undefined;
  const current = readOriginalFrozenRelayDocumentTarget(source, tools.principals, 'claude-code');
  const meshAgent = facet.meshCore?.getByPath(agentPath);
  if (
    current.sessionId !== sessionId ||
    current.agentPath !== agentPath ||
    current.agentId !== target.agentId ||
    homeOf(resolveAgentHome(agentPath, agentPath)) !== agentPath ||
    meshAgent?.id !== target.agentId
  )
    throw new Error('Original Relay target changed.');
  const pending: { retired: boolean; cleanupFailed?: boolean; cleanupCause?: unknown } = {
    retired: false,
  };
  facet.relayPreparing.set(sessionId, pending);
  let process: OriginalDocumentProcessReservation | undefined;
  let launch: OriginalPreparedRelaySdkLaunch | undefined;
  let setup:
    | {
        nativeOperation: object;
        nativeEntry: ClaudeNativeEntry;
        runtimeEntries: Map<string, ClaudeNativeEntry>;
        connectorTurn: ClaudeConnectorTurnContext | undefined;
      }
    | undefined;
  try {
    const reserved = reserveOriginalFrozenRelayDocumentProcess(
      source,
      tools.principals,
      facet.runtime
    );
    if (!reserved) {
      if (facet.relayPreparing.get(sessionId) === pending) facet.relayPreparing.delete(sessionId);
      return undefined;
    }
    process = reserved;
    const store = facet.claudeOriginalStores.get(facet.runtime)!;
    const session = await store.ensureForMessage(sessionId, facet.transcriptReader, facet.cwd, {
      cwd: agentPath,
    });
    if (pending.retired) throw new Error('Original Relay preparation retired.');
    setup = facet.installNativeTurn(
      sessionId,
      session,
      agentPath,
      agentPath,
      meshAgent,
      acquisition,
      true,
      undefined,
      pending
    );
    if (!setup.connectorTurn) throw new Error('Original Relay connector unavailable.');
    session.connectorTurn = setup.connectorTurn;
    await resolveOriginalClaudeConnectorPrincipal(setup.connectorTurn);
    const input = readOriginalFrozenRelayDocumentLaunchInput(source, tools.principals);
    session.unattendedApprovals = true;
    session.unattendedTurn = true;
    const senderOpts = facet.buildSenderOpts(sessionId, session, agentPath, agentPath);
    const messageOpts = {
      cwd: agentPath,
      unattended: true,
      unattendedApprovals: true,
      additionalContext: input.additionalContext,
    };
    launch = await prepareOriginalRelaySdkLaunch(
      sessionId,
      input.content,
      session,
      senderOpts,
      messageOpts,
      process
    );
    // Launch resolution awaits real credential/identity/configuration readers.
    // Revalidate the original source and acquisition after ALL of them.
    readOriginalFrozenRelayDocumentTarget(source, tools.principals, 'claude-code');
    requireOriginalPreparedRelaySdkLaunch(launch, session);
    const native = readClaudeNativeOperation(setup.nativeOperation),
      at = Date.now();
    const activity = captureNativeSessionActivity(acquisition, at);
    if (
      pending.retired ||
      !native ||
      native.canonicalSessionId !== sessionId ||
      native.agentPath !== agentPath ||
      native.canonicalCwd !== agentPath ||
      !activity ||
      !readNativeSessionAcquisition(acquisition, activity, at, sessionId)
    )
      throw new Error('Original Relay native entry retired.');
    const fixed = setup,
      fixedLaunch = launch,
      fixedProcess = process;
    let retirement: Promise<void> | undefined;
    const retire = () => {
      if (retirement) return retirement;
      // Latch original session exclusion before any owner retirement. Failed
      // cancellation/capacity settlement cannot admit a replacement turn.
      pending.retired = true;
      facet.relayPreparing.set(sessionId, pending);
      fixed.nativeEntry.retired = true;
      if (fixed.runtimeEntries.get(sessionId) === fixed.nativeEntry)
        fixed.runtimeEntries.delete(sessionId);
      if (session.connectorTurn === fixed.connectorTurn) session.connectorTurn = undefined;
      retirement = Promise.resolve().then(async () => {
        let failed = false;
        let first: unknown;
        const remember = (cause: unknown) => {
          if (!failed) {
            failed = true;
            first = cause;
          }
          pending.cleanupFailed = true;
          pending.cleanupCause = cause;
        };
        const launchDrain = Promise.resolve()
          .then(() => drainOriginalRelaySdkQuery(fixedLaunch, session))
          .catch(remember);
        const principalDrain = Promise.resolve()
          .then(() => fixed.connectorTurn!.cancel())
          .catch(remember);
        await Promise.allSettled([launchDrain, principalDrain]);
        try {
          fixedProcess.requireReleased();
        } catch (cause) {
          remember(cause);
        }
        if (failed) throw first;
        if (facet.relayPreparing.get(sessionId) === pending) facet.relayPreparing.delete(sessionId);
      });
      return retirement;
    };
    const prepared: PreparedRelayDocumentResponder = Object.freeze({
      kind: 'prepared-relay-document-responder',
    });
    facet.claudeRelayPrepared.set(prepared, {
      runtime: facet.runtime,
      source,
      operation: fixed.nativeOperation,
      acquisition,
      retire,
      launch: fixedLaunch,
      session,
      process: fixedProcess,
      principals: tools.principals,
      send: () =>
        executeSdkQuery(sessionId, input.content, session, senderOpts, messageOpts, 0, fixedLaunch),
      commit: () =>
        claimOriginalPreparedRelayDocumentFacts(
          source,
          facet.runtime,
          prepared,
          fixed.nativeOperation,
          tools.principals
        ),
    });
    facet.originalRelayLaunchPreparations.set(fixedLaunch, prepared);
    // Keep the exact original owner throughout prepared/query/process lifetime.
    return prepared;
  } catch (cause) {
    pending.retired = true;
    let originalSetupClosed = !setup;
    if (launch && setup) {
      try {
        retireOriginalPreparedRelaySdkLaunch(launch, setup.nativeEntry.session);
      } catch (cleanupCause) {
        pending.cleanupFailed = true;
        pending.cleanupCause = cleanupCause;
        originalSetupClosed = false;
      }
    }
    if (setup) {
      setup.nativeEntry.retired = true;
      if (setup.runtimeEntries.get(sessionId) === setup.nativeEntry)
        setup.runtimeEntries.delete(sessionId);
      if (setup.nativeEntry.session.connectorTurn === setup.connectorTurn)
        setup.nativeEntry.session.connectorTurn = undefined;
      try {
        if (!setup.connectorTurn)
          throw new Error('Original Relay setup cleanup owner unavailable', { cause });
        await setup.connectorTurn.revoke('setup_failed');
        originalSetupClosed = !pending.cleanupFailed;
      } catch (cleanupCause) {
        pending.cleanupFailed = true;
        pending.cleanupCause = cleanupCause;
      }
    }
    if (process) {
      try {
        process.releaseNeverInvoked();
      } catch (cleanupCause) {
        pending.cleanupFailed = true;
        pending.cleanupCause = cleanupCause;
        originalSetupClosed = false;
      }
    }
    // Positive original revoke and exact never-invoked capacity settlement release this slot. UNKNOWN
    // stays captured and excludes future work; the setup raw cause remains first.
    if (originalSetupClosed && facet.relayPreparing.get(sessionId) === pending)
      facet.relayPreparing.delete(sessionId);
    throw cause;
  }
}
