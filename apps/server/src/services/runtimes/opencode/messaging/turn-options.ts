import type { DirectoryGrant, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';
import { clampModeToCeiling, levelOfMode } from '@dorkos/shared/permission-semantics';
import type { PermissionModeId } from '@dorkos/shared/types';
import { OPENCODE_CAPABILITIES } from '../runtime-constants.js';
import type { OpenCodeSessionRegistry } from '../sessions/session-registry.js';

/** Authority and identity captured by one OpenCode turn, independent of later settings edits. */
export interface OpenCodeTurnOptions {
  connectorTurn?: boolean;
  forAgent?: string;
  grants?: readonly DirectoryGrant[];
  /** A mode requested for this send can further restrict the live chat mode. */
  sendPermissionMode?: PermissionModeId;
  /** Carried bounds, including marks independent of the selected mode. */
  permissionCeiling?: TurnPermissionCeiling;
  full?: boolean;
}

/** Read the live chat mode under this send's own selection, before applying carried bounds. */
export function readOpenCodeTurnMode(
  registry: OpenCodeSessionRegistry,
  sessionId: string,
  sendMode?: PermissionModeId
): PermissionModeId | undefined {
  const liveMode = registry.get(sessionId)?.permissionMode;
  const selectedLevel = levelOfMode(OPENCODE_CAPABILITIES.permissionModes, sendMode);
  return effectiveApprovalMode(liveMode, selectedLevel);
}

/** The live permission mode bounded by this turn's own ceiling, without changing stored settings. */
export function effectiveApprovalMode(
  mode: PermissionModeId | undefined,
  ceiling?: TurnPermissionCeiling
): PermissionModeId | undefined {
  return mode !== undefined && ceiling !== undefined
    ? clampModeToCeiling(OPENCODE_CAPABILITIES.permissionModes, mode, ceiling)
    : mode;
}
