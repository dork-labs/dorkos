/**
 * Project Transport methods factory (HTTP adapter) — the git main checkouts
 * the server knows (spec `flow-multiproject` §6.1). Talks to the
 * `/api/projects` routes through the generated API client (DOR-5473);
 * read-only.
 *
 * @module shared/lib/transport/project-methods
 */
import type { ProjectInfo, ProjectRef } from '@dorkos/shared/project-schemas';
import { createTransportApiClient } from './api-client';

/** Create the project methods bound to a base URL. */
export function createProjectMethods(baseUrl: string) {
  const api = createTransportApiClient(baseUrl);
  return {
    async listProjects(): Promise<ProjectInfo[]> {
      return (await api.call('projects.get', {})).projects;
    },

    async resolveProject(cwd: string): Promise<ProjectRef | null> {
      return (await api.call('projects.find_project', { query: { cwd } })).project;
    },
  };
}
