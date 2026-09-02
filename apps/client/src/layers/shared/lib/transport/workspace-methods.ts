/**
 * Workspace Transport methods factory (HTTP adapter) — isolated checkouts
 * (DOR-84, DOR-1056). Talks to the Express `/api/workspaces/*` routes.
 *
 * Read-only by design: the app shows the checkouts that exist and never creates,
 * pins, or deletes one. Provisioning stays an HTTP API that tools and scripts
 * call directly, so a stray click in the UI can never destroy a working tree.
 *
 * @module shared/lib/transport/workspace-methods
 */
import type { Workspace, WorktreeScanResult } from '@dorkos/shared/workspace';
import { fetchJSON, buildQueryString } from './http-client';

/** Create the workspace methods bound to a base URL. */
export function createWorkspaceMethods(baseUrl: string) {
  return {
    scanWorktrees(): Promise<WorktreeScanResult> {
      return fetchJSON<WorktreeScanResult>(baseUrl, '/workspaces/scan');
    },

    resolveWorkspace(absPath: string): Promise<Workspace | null> {
      const qs = buildQueryString({ path: absPath });
      return fetchJSON<{ workspace: Workspace | null }>(baseUrl, `/workspaces/resolve${qs}`).then(
        (r) => r.workspace
      );
    },
  };
}
