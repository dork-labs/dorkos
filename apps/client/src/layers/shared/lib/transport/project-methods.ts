/**
 * Project Transport methods factory (HTTP adapter) — the git main checkouts
 * the server knows (spec `flow-multiproject` §6.1). Talks to the Express
 * `/api/projects` routes; read-only.
 *
 * @module shared/lib/transport/project-methods
 */
import type {
  ProjectInfo,
  ProjectListResponse,
  ProjectRef,
  ProjectResolveResponse,
} from '@dorkos/shared/project-schemas';
import { fetchJSON, buildQueryString } from './http-client';

/** Create the project methods bound to a base URL. */
export function createProjectMethods(baseUrl: string) {
  return {
    listProjects(): Promise<ProjectInfo[]> {
      return fetchJSON<ProjectListResponse>(baseUrl, '/projects').then((r) => r.projects);
    },

    resolveProject(cwd: string): Promise<ProjectRef | null> {
      const qs = buildQueryString({ cwd });
      return fetchJSON<ProjectResolveResponse>(baseUrl, `/projects/resolve${qs}`).then(
        (r) => r.project
      );
    },
  };
}
