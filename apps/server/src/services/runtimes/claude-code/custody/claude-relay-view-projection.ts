import type { OriginalClaudeRelayConstructionView } from './claude-relay-construction-contracts.js';

const originalRelayProjectionFreeze = Object.freeze;

/** Caller-owned relay descriptor DATA and live readers; no registrar or effect admission. */
export interface OriginalClaudeRelayProjectionSources {
  readonly runtime: OriginalClaudeRelayConstructionView['runtime'];
  readonly originalLocks: OriginalClaudeRelayConstructionView['originalLocks'];
  readonly connectorRuntimeTools: () => OriginalClaudeRelayConstructionView['connectorRuntimeTools'];
  readonly relayPreparing: () => OriginalClaudeRelayConstructionView['relayPreparing'];
  readonly claudeRelayDriverStops: OriginalClaudeRelayConstructionView['claudeRelayDriverStops'];
  readonly claudeRelayDrivers: OriginalClaudeRelayConstructionView['claudeRelayDrivers'];
  readonly claudeRelayPreparers: OriginalClaudeRelayConstructionView['claudeRelayPreparers'];
  readonly claudeRelayPrepared: OriginalClaudeRelayConstructionView['claudeRelayPrepared'];
  readonly originalRelayClosedTurns: OriginalClaudeRelayConstructionView['originalRelayClosedTurns'];
  readonly originalRelayClosedTurnReaders: OriginalClaudeRelayConstructionView['originalRelayClosedTurnReaders'];
  readonly claudeRoomPreparers: OriginalClaudeRelayConstructionView['claudeRoomPreparers'];
  readonly claudeLockMoves: OriginalClaudeRelayConstructionView['claudeLockMoves'];
  readonly claudeRuntimeEntries: OriginalClaudeRelayConstructionView['claudeRuntimeEntries'];
  readonly claudeLockedRunners: OriginalClaudeRelayConstructionView['claudeLockedRunners'];
  readonly prepareRelayDocument: OriginalClaudeRelayConstructionView['prepareRelayDocument'];
  readonly prepareRoomResponder: OriginalClaudeRelayConstructionView['prepareRoomResponder'];
  readonly createMessage: OriginalClaudeRelayConstructionView['createMessage'];
}

/** Preserve the ordered relay descriptors without invoking supplied callbacks or readers. */
export function projectOriginalClaudeRelayView(
  sources: OriginalClaudeRelayProjectionSources
): Readonly<OriginalClaudeRelayConstructionView> {
  return originalRelayProjectionFreeze<OriginalClaudeRelayConstructionView>({
    runtime: sources.runtime,
    originalLocks: sources.originalLocks,
    get connectorRuntimeTools() {
      return sources.connectorRuntimeTools();
    },
    get relayPreparing() {
      return sources.relayPreparing();
    },
    claudeRelayDriverStops: sources.claudeRelayDriverStops,
    claudeRelayDrivers: sources.claudeRelayDrivers,
    claudeRelayPreparers: sources.claudeRelayPreparers,
    claudeRelayPrepared: sources.claudeRelayPrepared,
    originalRelayClosedTurns: sources.originalRelayClosedTurns,
    originalRelayClosedTurnReaders: sources.originalRelayClosedTurnReaders,
    claudeRoomPreparers: sources.claudeRoomPreparers,
    claudeLockMoves: sources.claudeLockMoves,
    claudeRuntimeEntries: sources.claudeRuntimeEntries,
    claudeLockedRunners: sources.claudeLockedRunners,
    prepareRelayDocument: sources.prepareRelayDocument,
    prepareRoomResponder: sources.prepareRoomResponder,
    createMessage: sources.createMessage,
  });
}
