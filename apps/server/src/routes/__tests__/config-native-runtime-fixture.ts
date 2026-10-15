/** Native adapters are outside this route fixture: settings use registered FakeAgentRuntime instances.
 * Keep the real registry and its policy/custody wrappers, while refusing any native operation.
 */
function noNativeIdentity(): undefined {
  return undefined;
}
function notNativeIdentity(): false {
  return false;
}
function unexpectedNativeOperation(): never {
  throw new Error('Config route fixture must not construct or operate a concrete native runtime');
}

export const claudeNativeRuntime = {
  ClaudeCodeRuntime: unexpectedNativeOperation,
  driveClaudeOriginalRelayDocument: unexpectedNativeOperation,
  isClaudeOriginalRoomLaunchAlias: notNativeIdentity,
  moveClaudeOriginalLockedAcquisition: unexpectedNativeOperation,
  observeOriginalClaudeRelayProjection: unexpectedNativeOperation,
  observeOriginalClaudeRelayTerminalProjection: unexpectedNativeOperation,
  prepareClaudeOriginalLockedRoomResponder: unexpectedNativeOperation,
  readClaudeNativeOperation: noNativeIdentity,
  readClaudeOriginalLockedStream: noNativeIdentity,
  readClaudeOriginalLockedTurnOptions: noNativeIdentity,
  readClaudeOriginalRoomResponderStream: noNativeIdentity,
  readClaudePreparedRoomResponder: noNativeIdentity,
  readOriginalClaudeRelayClosedTurn: noNativeIdentity,
  readOriginalClaudeRelayClosedTurnData: noNativeIdentity,
  readOriginalClaudeRelayProjectedTurnStart: noNativeIdentity,
  readOriginalClaudeRelayProjectionProjector: noNativeIdentity,
  requireClaudeOriginalRelayPreparedTuple: unexpectedNativeOperation,
  retireClaudeOriginalRoomResponderStream: unexpectedNativeOperation,
  retireClaudePreparedRoomResponder: unexpectedNativeOperation,
  sendClaudeOriginalLockedMessage: unexpectedNativeOperation,
  startClaudeCommittedRoomResponder: unexpectedNativeOperation,
  stopClaudeOriginalRelayDocumentDrive: unexpectedNativeOperation,
};

export const codexNativeRuntime = {
  CodexRuntime: unexpectedNativeOperation,
  prepareCodexOriginalLockedRoomResponder: unexpectedNativeOperation,
  readCodexNativeOperation: noNativeIdentity,
  readCodexOriginalLockedStream: noNativeIdentity,
  readCodexOriginalLockedTurnOptions: noNativeIdentity,
  readCodexOriginalRoomResponderStream: noNativeIdentity,
  readCodexPreparedRoomResponder: noNativeIdentity,
  retireCodexOriginalRoomResponderStream: unexpectedNativeOperation,
  retireCodexPreparedRoomResponder: unexpectedNativeOperation,
  sendCodexOriginalLockedMessage: unexpectedNativeOperation,
  startCodexCommittedRoomResponder: unexpectedNativeOperation,
};

export const openCodeNativeRuntime = {
  OpenCodeRuntime: unexpectedNativeOperation,
  prepareOpenCodeOriginalLockedRoomResponder: unexpectedNativeOperation,
  readOpenCodeNativeOperation: noNativeIdentity,
  readOpenCodeOriginalLockedStream: noNativeIdentity,
  readOpenCodeOriginalLockedTurnOptions: noNativeIdentity,
  readOpenCodeOriginalRoomResponderStream: noNativeIdentity,
  readOpenCodePreparedRoomResponder: noNativeIdentity,
  retireOpenCodeOriginalRoomResponderStream: unexpectedNativeOperation,
  retireOpenCodePreparedRoomResponder: unexpectedNativeOperation,
  sendOpenCodeOriginalLockedMessage: unexpectedNativeOperation,
  startOpenCodeCommittedRoomResponder: unexpectedNativeOperation,
};

export const testModeNativeRuntime = {
  TestModeRuntime: unexpectedNativeOperation,
  isOriginalNativeTestModeRuntime: notNativeIdentity,
  isTestModeOriginalRoomLaunchAlias: notNativeIdentity,
  moveTestModeOriginalLockedAcquisition: unexpectedNativeOperation,
  prepareTestModeOriginalLockedRoomResponder: unexpectedNativeOperation,
  readTestModeNativeOperation: noNativeIdentity,
  readTestModeOriginalCanonicalSessionId: noNativeIdentity,
  readTestModeOriginalNativeStream: noNativeIdentity,
  readTestModeOriginalNativeTurnOptions: noNativeIdentity,
  readTestModeOriginalRoomResponderStream: noNativeIdentity,
  readTestModeOriginalScenarioEvidence: noNativeIdentity,
  readTestModeOriginalStopTerminalData: noNativeIdentity,
  readTestModePreparedRoomResponder: noNativeIdentity,
  requireTestModeOriginalRoomEmissionClosed: unexpectedNativeOperation,
  retireTestModeOriginalRoomResponderStream: unexpectedNativeOperation,
  retireTestModePreparedRoomResponder: unexpectedNativeOperation,
  sendTestModeOriginalLockedMessage: unexpectedNativeOperation,
  startTestModeCommittedRoomResponder: unexpectedNativeOperation,
};
