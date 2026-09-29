/**
 * OpenAPI entries for the project routes (spec `flow-multiproject` §6.1),
 * projected from the same schemas the routes parse and answer with.
 *
 * @module services/projects/projects-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  ProjectListResponseSchema,
  ProjectResolveQuerySchema,
  ProjectResolveResponseSchema,
} from '@dorkos/shared/project-schemas';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

/**
 * Register `GET /api/projects` and `GET /api/projects/resolve` on the OpenAPI registry.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerProjectsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/projects',
    tags: ['Projects'],
    summary: 'List the projects this machine knows',
    description:
      'Every git main checkout the server has seen as a session, agent, workspace or install ' +
      'folder, or that an extension reported, whose folder exists right now, sorted by name. A ' +
      'project whose folder is gone is hidden, not forgotten (a drive may be unplugged). Each ' +
      "project's `name` is URL-safe, unique, and never changes once given: the folder's name, or " +
      '`name~parent` when another project already had it. `originRepo` is the `owner/name` of a ' +
      'GitHub `origin` remote, else null.',
    responses: {
      200: {
        description: 'The known projects',
        content: { 'application/json': { schema: ProjectListResponseSchema } },
      },
      500: error('The projects could not be read'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/projects/resolve',
    tags: ['Projects'],
    summary: 'Name the project a folder belongs to',
    description:
      'The git main checkout `cwd` belongs to: a linked worktree and a subfolder both map to it, ' +
      'and a bare repository is its own project. A folder in no repository answers ' +
      '`{ "project": null }`, including one that only holds several repositories. The project is ' +
      'remembered, so it appears in `GET /api/projects` from then on. The folder must be inside ' +
      "the server's directory boundary.",
    request: { query: ProjectResolveQuerySchema },
    responses: {
      200: {
        description: 'The project, or null',
        content: { 'application/json': { schema: ProjectResolveResponseSchema } },
      },
      400: error('`cwd` is missing or empty'),
      403: error("`cwd` is outside the server's directory boundary"),
      500: error('The project could not be resolved'),
    },
  });
}
