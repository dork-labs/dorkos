/**
 * OpenAPI entries for extension decisions, per-project settings and starting
 * work in a new chat (spec `flow-multiproject` §7.3, §7.7, §7.8, §7.10),
 * projected from the same schemas the routes parse and answer with.
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
  StartWorkRequestSchema,
  StartWorkResponseSchema,
} from '@dorkos/shared/extension-decision-schemas';
import { StepUpRequiredBodySchema } from '@dorkos/shared/step-up';
import { problemResponse as error } from '../../core/openapi/problem-openapi.js';

const VALIDATION = { $ref: '#/components/responses/ValidationProblem' } as const;

const remoteConfirmation = {
  description: 'A remote yes or accepted offer needs fresh confirmation for this request',
  content: { 'application/json': { schema: StepUpRequiredBodySchema } },
};

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
      400: VALIDATION,
      503: error('`temporarily_unavailable`: the inbox is not ready yet'),
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
      428: remoteConfirmation,
      200: { description: 'What the answer came to', content: json(DecisionActionResponseSchema) },
      400: error(
        '`invalid_request`: the answer does not fit the decision, or a note is over 2000 characters'
      ),
      403: error('`person_only`: not a person; `not_from_wifi`: a yes sent over Wi-Fi'),
      404: error('`not_found`: no such decision'),
      409: error(
        '`not_running` (the extension is off), `already_resolved` (settled already), or ' +
          '`conflict` (the extension is still working on it)'
      ),
      412: error('`precondition_failed`: the question changed since the person saw it'),
      502: error('`temporarily_unavailable`: the extension refused it; the decision stays open'),
      503: error('`temporarily_unavailable`: the inbox is not ready yet'),
      504: error(
        '`temporarily_unavailable`: the extension did not answer in time; the decision stays open'
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
      428: remoteConfirmation,
      200: {
        description: 'What the extension said back',
        content: json(DecisionOfferResponseSchema),
      },
      400: error('`invalid_request`: not `{ accept: true | false }`'),
      403: error('`person_only`: not a person; `not_from_wifi`: a yes sent over Wi-Fi'),
      404: error('`not_found`: no such decision'),
      409: error(
        '`already_resolved` (the offer was used, dismissed or is over 15 minutes old), ' +
          '`not_running`, or `conflict` (the project is gone or out of scope)'
      ),
      500: error('`internal_error`: the settings store could not be written'),
      503: error('`temporarily_unavailable`: the inbox is not ready yet'),
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
      400: error('`invalid_request`: not a valid extension id'),
      503: error('`temporarily_unavailable`: the inbox is not ready yet'),
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
      428: remoteConfirmation,
      200: { description: 'What the answer came to', content: json(DecisionActionResponseSchema) },
      400: error('`invalid_request`: the answer does not fit the decision'),
      403: error('`person_only`: not a person; `not_from_wifi`: a yes sent over Wi-Fi'),
      404: error('`not_found`: no such decision for this extension'),
      409: error('`not_running` or `already_resolved`'),
      412: error('`precondition_failed`: the question changed since it was shown'),
      502: error('`temporarily_unavailable`: the extension refused it'),
      503: error('`temporarily_unavailable`: the inbox is not ready yet'),
      504: error('`temporarily_unavailable`: the extension did not answer in time'),
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
      400: error('`invalid_request`: no `project` query, or not a valid extension id'),
      403: error('`outside_boundary`: the folder is outside the server’s directory boundary'),
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
      400: error('`invalid_request`: not `{ project, value }`, or the value is not JSON'),
      403: error('`person_only`: not a person'),
      404: error('`not_found`: no such extension, or it is not set up in that project'),
      413: error('`request_too_large`: the value is larger than 16 KiB'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/extensions/{id}/start-work',
    tags: ['Extensions'],
    summary: 'Start work in a new chat for an extension',
    description:
      'What an extension’s outcome button calls (`api.startWork`). Starts one NEW chat in the ' +
      'project’s root on the default runtime: the prompt is sent at once as its first message, ' +
      'the title is set, and the chat says "Started by the <extension> extension: <reason>" as its first ' +
      'line. The current chat is never touched and nothing navigates. The project must hold a ' +
      'copy of the extension, have been reported by it, or be one the person works in. At most ' +
      '10 starts per rolling hour and 3 running chats per extension, counted with the chats its ' +
      'chats started; the hourly count survives a restart. Recorded as started by the ' +
      `extension, whether or not a person clicked. ${PERSON_BAR}`,
    request: { params: extensionIdParam, body: { content: json(StartWorkRequestSchema) } },
    responses: {
      200: { description: 'Started', content: json(StartWorkResponseSchema) },
      400: error('`invalid_request`: the body breaks a length rule'),
      403: error('`person_only`: not a person'),
      404: error('`not_found`: no such extension, or the folder is not inside a project'),
      409: error(
        '`conflict`: the extension is off; `account_not_allowed_here`: that account can’t work there'
      ),
      429: error('`rate_limited`: too many starts or working chats'),
      503: error('`temporarily_unavailable`: chats cannot be started yet'),
    },
  });
}
