import type { DirectoryGrant, TurnPermissionCeiling } from '@dorkos/shared/agent-runtime';

/** Authority and identity captured by one OpenCode turn, independent of later settings edits. */
export interface OpenCodeTurnOptions {
  connectorTurn?: boolean;
  forAgent?: string;
  grants?: readonly DirectoryGrant[];
  permissionCeiling?: TurnPermissionCeiling;
  full?: boolean;
}
