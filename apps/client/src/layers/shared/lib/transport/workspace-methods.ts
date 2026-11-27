/**
 * Workspace Transport methods factory (HTTP adapter) — isolated checkouts
 * (DOR-84, DOR-1056). Talks to the `/api/workspaces/*` routes.
 *
 * Read-only by design: the app shows the checkouts that exist and never creates,
 * pins, or deletes one. Provisioning stays an HTTP API that tools and scripts
 * call directly, so a stray click in the UI can never destroy a working tree.
 *
 * @module shared/lib/transport/workspace-methods
 */
import type { Workspace, WorktreeScanResult } from '@dorkos/shared/workspace';
import { createTransportApiClient } from './api-client';
import { fetchJSON, buildQueryString } from './http-client';

/** Create the workspace methods bound to a base URL. */
export function createWorkspaceMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async scanWorktrees(): Promise<WorktreeScanResult> {
      const answer = await api.call('workspaces.scan', {});
      // The document also lists the capability mount's 202 approval answer,
      // which a person's own read never gets; the cast keeps today's type.
      return answer as WorktreeScanResult;
    },

    // Stays hand-written: `GET /api/workspaces/resolve` has no operationId (DOR-5473).
    resolveWorkspace(absPath: string): Promise<Workspace | null> {
      const qs = buildQueryString({ path: absPath });
      return fetchJSON<{ workspace: Workspace | null }>(baseUrl, `/workspaces/resolve${qs}`).then(
        (r) => r.workspace
      );
    },
  };
}
