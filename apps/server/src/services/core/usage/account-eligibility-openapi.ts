/**
 * OpenAPI entries for the account-rule routes (spec `flow-multiproject` §8.6),
 * projected from the same schemas the routes parse and answer with.
 *
 * @module services/core/usage/account-eligibility-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import {
  AccountEligibilityQuerySchema,
  AccountEligibilityResponseSchema,
  OnlyProjectsRequestSchema,
  OnlyProjectsResponseSchema,
  ProjectAccountsRequestSchema,
} from '@dorkos/shared/project-schemas';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

const PERSON_BAR =
  'Only a person may call it: a request from another site, a caller that names itself an agent ' +
  '(`X-DorkOS-Agent`), and, with Require login on, a caller without a signed-in session are ' +
  'refused with `403`. With Require login off, a local caller that sends no agent header is ' +
  "trusted, and an approved extension's own browser code shares the app's page, so it passes " +
  'in either posture. Each change is recorded in Activity.';

/**
 * Register the three `/api/runtimes/claude-code/...` account-rule routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerAccountEligibilityOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/runtimes/claude-code/account-eligibility',
    tags: ['Runtimes'],
    summary: 'Which Claude accounts may work in a project',
    description:
      'Every Claude account (Main is `default`) as the project a folder belongs to sees it. An ' +
      'account may work in a project only when both rules allow it: its own (`onlyProjects`, ' +
      'null for any project; a list never allows a folder in no project) and the project’s ' +
      '(`allow`, null when the project has no list). Leave out `project` for a folder in no ' +
      'project.',
    request: { query: AccountEligibilityQuerySchema },
    responses: {
      200: {
        description: 'The project and every account',
        content: { 'application/json': { schema: AccountEligibilityResponseSchema } },
      },
      400: error('The query is not valid'),
      403: error("The folder, or its repository, is outside the server's directory boundary"),
      500: error('The rules could not be read'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/runtimes/claude-code/project-accounts',
    tags: ['Runtimes'],
    summary: 'Choose which Claude accounts a project may use',
    description:
      'Sets the project’s allow list, or removes it with `allow: null` (every account again). ' +
      `Answers with the project's new eligibility. ${PERSON_BAR}`,
    request: {
      body: { content: { 'application/json': { schema: ProjectAccountsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The project and every account, after the change',
        content: { 'application/json': { schema: AccountEligibilityResponseSchema } },
      },
      400: error('The body is not valid, or it names an account that does not exist'),
      403: error('Not a person, or the folder is outside the directory boundary'),
      404: error('The folder is not in a project (a git repository)'),
      500: error('The change could not be saved'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/runtimes/claude-code/accounts/{id}/only-projects',
    tags: ['Runtimes'],
    summary: 'Keep a Claude account to some projects',
    description:
      'Sets the projects one account may work in (`default` is Main), or frees it with ' +
      `\`projects: null\`. An account kept to projects never works in a folder that is in no project. ${PERSON_BAR}`,
    request: {
      body: { content: { 'application/json': { schema: OnlyProjectsRequestSchema } } },
    },
    responses: {
      200: {
        description: 'The projects the account is now kept to, or null',
        content: { 'application/json': { schema: OnlyProjectsResponseSchema } },
      },
      400: error('The body is not valid, or a folder is not a project'),
      403: error('Not a person'),
      404: error('There is no such account'),
      500: error('The change could not be saved'),
    },
  });
}
