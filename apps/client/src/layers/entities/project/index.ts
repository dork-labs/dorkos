/**
 * Project entity — the git main checkouts the server knows, and the one the
 * selected folder belongs to (spec `flow-multiproject` §6.1, §6.4).
 *
 * @module entities/project
 */
export { projectKeys } from './api/queries';
export { useProjectForCwd, type ProjectForCwd } from './model/use-project-for-cwd';
export { useProjects } from './model/use-projects';
export { useCurrentProjectSync } from './model/use-current-project-sync';
export type { ProjectRef, ProjectInfo } from '@dorkos/shared/project-schemas';
