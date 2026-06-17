/**
 * Workspace entity — domain hooks for server-managed isolated workspaces (DOR-84).
 *
 * @module entities/workspace
 */
export { useWorkspaces, useInvalidateWorkspaces, workspacesQueryKey } from './model/use-workspaces';
export { useWorkspaceForSession } from './model/use-workspace-for-session';
export { derivePorts } from '@dorkos/shared/workspace';
export type {
  Workspace,
  WorkspaceWithSessions,
  WorkspaceStatus,
  WorkspaceProviderType,
  AttachedSession,
  RemoveResult,
  WorkspacePorts,
} from '@dorkos/shared/workspace';
