/**
 * Workspace Transport methods factory (HTTP adapter) — server-managed isolated
 * checkouts (DOR-84). Talks to the Express `/api/workspaces/*` routes.
 *
 * @module shared/lib/transport/workspace-methods
 */
import type {
  Workspace,
  WorkspaceWithSessions,
  EnsureWorkspaceRequest,
  RemoveResult,
} from '@dorkos/shared/workspace';
import { fetchJSON, buildQueryString } from './http-client';

/** Create the workspace methods bound to a base URL. */
export function createWorkspaceMethods(baseUrl: string) {
  return {
    listWorkspaces(projectKey?: string): Promise<WorkspaceWithSessions[]> {
      const qs = buildQueryString({ projectKey });
      return fetchJSON<{ workspaces: WorkspaceWithSessions[] }>(baseUrl, `/workspaces${qs}`).then(
        (r) => r.workspaces
      );
    },

    resolveWorkspace(absPath: string): Promise<Workspace | null> {
      const qs = buildQueryString({ path: absPath });
      return fetchJSON<{ workspace: Workspace | null }>(baseUrl, `/workspaces/resolve${qs}`).then(
        (r) => r.workspace
      );
    },

    ensureWorkspace(req: EnsureWorkspaceRequest): Promise<Workspace> {
      return fetchJSON<Workspace>(baseUrl, '/workspaces', {
        method: 'POST',
        body: JSON.stringify(req),
      });
    },

    pinWorkspace(id: string, pinned: boolean): Promise<Workspace> {
      return fetchJSON<Workspace>(baseUrl, `/workspaces/${id}/pin`, {
        method: 'POST',
        body: JSON.stringify({ pinned }),
      });
    },

    removeWorkspace(id: string, force = false): Promise<RemoveResult> {
      const qs = buildQueryString({ force: force || undefined });
      return fetchJSON<RemoveResult>(baseUrl, `/workspaces/${id}${qs}`, { method: 'DELETE' });
    },
  };
}
