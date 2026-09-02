/**
 * Workspace entity — domain hooks for isolated checkouts (DOR-84, DOR-1056).
 *
 * @module entities/workspace
 */
export { useWorktreeScan, worktreeScanQueryKey } from './model/use-worktree-scan';
export { useWorkspaceForSession } from './model/use-workspace-for-session';
export { derivePorts } from '@dorkos/shared/workspace';
export type {
  Workspace,
  WorkspaceStatus,
  WorkspaceProviderType,
  WorkspacePorts,
  WorktreeScanEntry,
  WorktreeScanResult,
} from '@dorkos/shared/workspace';
