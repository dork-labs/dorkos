/**
 * OpenAPI entries for `/api/hub/agent-grants` (`routes/hub-agent-grants.ts`):
 * what a hub's owner allows its agents on agent computers beyond their own
 * settings. Bodies are the grants store's own (`setup-grants-store.ts`).
 *
 * @module services/core/tool-bridge/agent-grants-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  AgentPairBodySchema,
  DorkBotSetupBodySchema,
  SetupGrantsSchema,
} from './setup-grants-store.js';

const TAGS = ['Hub'];

const ErrorSchema = z.object({ error: z.string(), code: z.string() });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

const GRANTS = json(SetupGrantsSchema, 'The grants as now stored');
const OWNER_ONLY = json(
  ErrorSchema,
  "Not the person's own browser sign-in: an agent or an API key never reaches these routes"
);
const NOT_A_HUB = json(ErrorSchema, 'Not a hub');
const INVALID = json(ErrorSchema, 'The body is not one of the shapes above');

/**
 * Register the owner's agent grant routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerAgentGrantsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: '/api/hub/agent-grants',
    tags: TAGS,
    summary: 'Read what agents on agent computers are allowed',
    description:
      "On a hub, for its owner's own browser sign-in: whether DorkBot may set things up " +
      'from an agent computer, and which agents may start full turns for which others.',
    responses: { 200: GRANTS, 403: OWNER_ONLY, 404: NOT_A_HUB },
  });

  registry.registerPath({
    method: 'put',
    path: '/api/hub/agent-grants/dorkbot-setup',
    tags: TAGS,
    summary: "Turn DorkBot's setup level on or off",
    description:
      'With it on, DorkBot alone, working on an agent computer, may use the tools that set ' +
      'up the hub: settings, permissions, packages, connections and agents. Its destructive ' +
      'calls still ask for approval.',
    request: { body: { content: { 'application/json': { schema: DorkBotSetupBodySchema } } } },
    responses: { 200: GRANTS, 400: INVALID, 403: OWNER_ONLY, 404: NOT_A_HUB },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/hub/agent-grants/pairs',
    tags: TAGS,
    summary: 'Let one agent start full turns for another',
    description:
      'One way only: a turn agent `from` starts for agent `to` on another computer runs at ' +
      'the owner tier instead of the teammate tier. Allowing a pair again keeps its date.',
    request: { body: { content: { 'application/json': { schema: AgentPairBodySchema } } } },
    responses: {
      200: GRANTS,
      400: INVALID,
      403: OWNER_ONLY,
      404: NOT_A_HUB,
      409: json(ErrorSchema, 'The file holds as many pairs as it can'),
    },
  });

  registry.registerPath({
    method: 'delete',
    path: '/api/hub/agent-grants/pairs/{from}/{to}',
    tags: TAGS,
    summary: 'Take a pair allowance back',
    request: { params: z.object({ from: z.string(), to: z.string() }) },
    responses: { 200: GRANTS, 400: INVALID, 403: OWNER_ONLY, 404: NOT_A_HUB },
  });
}
