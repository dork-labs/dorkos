/**
 * OpenAPI entries for extension decisions and per-project settings (spec
 * `flow-multiproject` §7.3, §7.8, §7.10), projected from the same schemas the
 * routes parse and answer with.
 *
 * @module services/extensions/extension-decisions-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  DecisionActionRequestSchema,
  DecisionActionResponseSchema,
  DecisionOfferRequestSchema,
  DecisionOfferResponseSchema,
  ListExtensionDecisionsQuerySchema,
  ListExtensionDecisionsResponseSchema,
  ProjectSettingsQuerySchema,
  ProjectSettingsResponseSchema,
  PutProjectSettingsRequestSchema,
} from '@dorkos/shared/extension-decision-schemas';
import { ErrorResponseSchema } from '@dorkos/shared/schemas';

const error = (description: string) => ({
  description,
  content: { 'application/json': { schema: ErrorResponseSchema } },
});

const json = <T extends z.ZodType>(schema: T) => ({ 'application/json': { schema } });

/** The residual every person-bar route here carries, said once. */
const PERSON_BAR =
  'Behind the person bar: an agent that names itself is refused, and with Require login on so ' +
  'is anything without the person’s cookie. With login off a local caller that does not name ' +
  'itself an agent passes, and in any posture an approved extension’s own page code can call ' +
  'it; that is the trust a person grants when they turn an extension on.';

const decisionIdParam = z.object({ id: z.string().describe('Core’s id for the decision.') });
const extensionIdParam = z.object({ id: z.string().describe('The extension id.') });

/**
 * Register the decision and project-settings routes on the OpenAPI registry.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerExtensionDecisionsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/extension-decisions',
    tags: ['Extensions'],
    summary: 'List the decisions extensions are asking about',
    description:
      'Open decisions raised through `ctx.inbox` by extensions that are running, whose project ' +
      'folder exists, oldest first. `offers` holds the one-time "next time, on its own?" lines ' +
      'a person has not answered yet (they lapse after 15 minutes). `extensionId` narrows it to ' +
      'one extension.',
    request: { query: ListExtensionDecisionsQuerySchema },
    responses: {
      200: {
        description: 'Open decisions and waiting offers',
        content: json(ListExtensionDecisionsResponseSchema),
      },
      400: error('The query is malformed'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extension-decisions/{id}/action',
    tags: ['Extensions'],
    summary: 'Answer a decision (the bell and the inbox)',
    description:
      'A person answers in DorkOS’s own UI. Core calls the extension’s action handler (5 seconds ' +
      'at most) and then resolves the decision, attributed to the person, or keeps it open when ' +
      'the extension asks to. The row is re-checked after the handler, so a decision settled ' +
      'meanwhile answers `already_resolved` and nothing is recorded. `navigate` is an in-app path ' +
      `already checked. ${PERSON_BAR}`,
    request: { params: decisionIdParam, body: { content: json(DecisionActionRequestSchema) } },
    responses: {
      200: { description: 'What the answer came to', content: json(DecisionActionResponseSchema) },
      400: error('The answer does not fit the decision, or a note is over 2000 characters'),
      403: error('Not a person'),
      404: error('No such decision'),
      409: error('`not_running` (the extension is not running) or `already_resolved`'),
      502: error('The extension could not take the answer; the decision stays open'),
      504: error(
        '`extension_timeout`: the extension did not answer in time; the decision stays open'
      ),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extension-decisions/{id}/offer',
    tags: ['Extensions'],
    summary: 'Answer a one-time "next time, on its own?" offer',
    description:
      '"Yes" first applies the offer’s settings change to the extension’s per-project settings, as ' +
      'the person, then tells the extension. A dismiss tells it nothing. Either way the offer is ' +
      `used up. ${PERSON_BAR}`,
    request: { params: decisionIdParam, body: { content: json(DecisionOfferRequestSchema) } },
    responses: {
      200: {
        description: 'What the extension said back',
        content: json(DecisionOfferResponseSchema),
      },
      403: error('Not a person'),
      404: error('No such decision'),
      409: error('`offer_gone`: used, dismissed, or older than 15 minutes; or `not_running`'),
      422: error('The settings change could not be made; nothing changed'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/extensions/{id}/decisions',
    tags: ['Extensions'],
    summary: 'List one extension’s open decisions (its own pages)',
    description:
      'What `api.listDecisions()` calls: the open decisions this extension raised, as the inbox ' +
      'shows them. Scoped to `{id}`.',
    request: { params: extensionIdParam },
    responses: {
      200: {
        description: 'The extension’s open decisions',
        content: json(ListExtensionDecisionsResponseSchema),
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extensions/{id}/decisions/{decisionId}/action',
    tags: ['Extensions'],
    summary: 'Answer one of an extension’s decisions from its own page',
    description:
      'What `api.answerDecision()` calls. Scoped to `{id}`: another extension’s decision is 404. ' +
      'An answer here is attributed to the extension ("answered in Flow"), never to a person, ' +
      `and never returns an offer. ${PERSON_BAR}`,
    request: {
      params: extensionIdParam.extend({ decisionId: z.string() }),
      body: { content: json(DecisionActionRequestSchema) },
    },
    responses: {
      200: { description: 'What the answer came to', content: json(DecisionActionResponseSchema) },
      400: error('The answer does not fit the decision'),
      403: error('Not a person'),
      404: error('No such decision for this extension'),
      409: error('`not_running` or `already_resolved`'),
      502: error('The extension could not take the answer'),
      504: error('`extension_timeout`'),
    },
  });

  registry.registerPath({
    method: 'get',
    path: '/api/extensions/{id}/project-settings',
    tags: ['Extensions'],
    summary: 'Read an extension’s settings for one project',
    description:
      'What `api.projectSettings.get()` calls: the value a person stored for this extension in ' +
      'the project `project` belongs to, or null.',
    request: { params: extensionIdParam, query: ProjectSettingsQuerySchema },
    responses: {
      200: {
        description: 'The stored value, or null',
        content: json(ProjectSettingsResponseSchema),
      },
      403: error('The folder is outside the server’s directory boundary'),
    },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/extensions/{id}/project-settings',
    tags: ['Extensions'],
    summary: 'Change an extension’s settings for one project',
    description:
      'The only writer of an extension’s per-project settings (an autonomy dial lives here): ' +
      'the extension’s server half can read them and never write them. The project must hold a ' +
      'copy of the extension or have been reported by it. The value is any JSON, at most 16 KiB. ' +
      `Recorded as written from the extension's page, with an Activity entry. ${PERSON_BAR}`,
    request: { params: extensionIdParam, body: { content: json(PutProjectSettingsRequestSchema) } },
    responses: {
      204: { description: 'Saved' },
      400: error('Not `{ project, value }`, or the value is not JSON'),
      403: error('Not a person'),
      404: error('No such extension, or it is not set up in that project'),
      413: error('The value is larger than 16 KiB'),
    },
  });
}
