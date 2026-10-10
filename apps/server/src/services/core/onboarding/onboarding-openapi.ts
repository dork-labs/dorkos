/**
 * OpenAPI entries for the first-run routes (`routes/onboarding.ts`), projected
 * from the schemas they parse and answer with.
 *
 * @module services/core/onboarding/onboarding-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z } from 'zod';
import {
  FirstRunResultSchema,
  OnboardingWelcomeResultSchema,
} from '@dorkos/shared/onboarding-schemas';

/**
 * The request body as documented. The route parses `FirstRunRequestSchema`,
 * whose custom setup refuses a key reference with `z.never()`, which OpenAPI
 * cannot express; this flattens the same union for the reference page.
 */
const FirstRunRequestDocSchema = z.object({
  path: z.enum(['dorkos', 'own', 'none']),
  choice: z
    .object({
      kind: z.enum(['openai', 'anthropic', 'openrouter', 'local', 'custom', 'agent-app']),
      apiKey: z.string().optional(),
      inference: z
        .record(z.string(), z.unknown())
        .optional()
        .describe('For `custom`: source, provider, protocol, endpoint, model and limits'),
    })
    .optional()
    .describe('For `own`: what was picked in the Own AI list'),
});

/** A refusal: the sentence a person reads, and a code the client acts on. */
const RefusalSchema = z.object({ error: z.string(), code: z.string().optional() });

/** A refusal response, described. */
function refusal(description: string) {
  return { description, content: { 'application/json': { schema: RefusalSchema } } };
}

/**
 * Register the first-run routes.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerOnboardingOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: '/api/onboarding/first-run',
    tags: ['Onboarding'],
    summary: 'Record and set up the path picked on the Welcome screen',
    description:
      'Calls run one at a time. Checks the key and reads the service model list with it first, ' +
      'and writes nothing when either refuses. Then undoes what an earlier pick set up (a ' +
      'credits record goes back to the own sign-in, the default runtime and DorkBot go back to ' +
      'what they were) and applies this one: DorkOS moves the default runtime and DorkBot to ' +
      'DorkOS, clears the model setup so DorkOS picks the model, and leaves credits to the new ' +
      'link; Own AI saves the key (or finds the local model) with the model DorkOS picked from ' +
      "the service's list and turns credits off for DorkOS; no account records the path only. " +
      'This computer and its owner only.',
    request: {
      body: { content: { 'application/json': { schema: FirstRunRequestDocSchema } } },
    },
    responses: {
      200: {
        description: 'What the pick set up',
        content: { 'application/json': { schema: FirstRunResultSchema } },
      },
      400: refusal(
        'Not a known path, or the key or setup was refused (`invalid_key`, `invalid_setup`)'
      ),
      403: refusal('Not this computer, or not the owner'),
      409: refusal('The first run is finished or dismissed (`onboarding_complete`)'),
      502: refusal("The service's model list could not be read with the key; nothing was saved"),
    },
  });

  registry.registerPath({
    method: 'post',
    path: '/api/onboarding/welcome',
    tags: ['Onboarding'],
    summary: "Post DorkBot's first-run welcome into #team, once",
    description:
      'Posts the welcome as DorkBot without starting any agent turn or notification (and never ' +
      'to a chat bridge), keeps its entry id in `onboarding.welcomeEntryId`, and answers with ' +
      'it. A later call answers with the same entry while #team still holds it, and posts nothing.',
    responses: {
      200: {
        description: 'The welcome entry',
        content: { 'application/json': { schema: OnboardingWelcomeResultSchema } },
      },
      403: refusal('Not the owner'),
      409: refusal(
        'The first run finished or was dismissed without a welcome (`onboarding_complete`)'
      ),
      503: refusal('#team, or DorkBot in it, is not ready yet (`team_unavailable`)'),
    },
  });
}
