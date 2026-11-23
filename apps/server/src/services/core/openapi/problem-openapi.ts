/**
 * The one error shape in the API document: the `Problem` schema
 * (`application/problem+json`, RFC 9457) and the answers the chain itself
 * gives every route, whatever the route declares (DOR-4979).
 *
 * Each is a reusable response under `components.responses`, so a route's own
 * declaration can point at it as the routes move to this shape folder by
 * folder.
 *
 * @module services/core/openapi/problem-openapi
 */
import type { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { PROBLEM_CONTENT_TYPE, ProblemCodeSchema, ProblemSchema } from '@dorkos/shared/problem';

/** The chain's own answers: name, then what a reader is told it means. */
const CHAIN_RESPONSES = [
  [
    'ValidationProblem',
    '400 `invalid_request`: the input failed its schema. `detail` names the first field; `issues` lists them all.',
  ],
  [
    'MalformedRequestProblem',
    '400 `malformed_request`: the body could not be read (broken JSON, a cut-off form).',
  ],
  ['NotFoundProblem', '404 `not_found`: no API route at that path, or that method.'],
  ['RequestTooLargeProblem', '413 `request_too_large`: the body is over the request limit.'],
  [
    'InternalErrorProblem',
    '500 `internal_error`: the server failed; nothing the caller sent was wrong.',
  ],
] as const;

/**
 * Register the `Problem` schema, its code list and the chain's own answers.
 *
 * @param registry - The server's OpenAPI registry.
 */
export function registerProblemOpenApi(registry: OpenAPIRegistry): void {
  registry.register('Problem', ProblemSchema);
  registry.register('ProblemCode', ProblemCodeSchema);
  for (const [name, description] of CHAIN_RESPONSES) {
    registry.registerComponent('responses', name, {
      description,
      // A component is stored as written, never converted from Zod: point at
      // the registered schema rather than embedding it.
      content: { [PROBLEM_CONTENT_TYPE]: { schema: { $ref: '#/components/schemas/Problem' } } },
    });
  }
}

/**
 * The content of an error response a route declares: a problem document. The
 * schema is the registered `Problem`, so the document points at it.
 */
export const PROBLEM_CONTENT = { [PROBLEM_CONTENT_TYPE]: { schema: ProblemSchema } } as const;

/**
 * One error response for a route's `responses` map: what it means, and the
 * problem document it carries.
 *
 * @param description - When the route answers this status, and with which code.
 * @returns The response declaration.
 */
export function problemResponse(description: string): {
  description: string;
  content: typeof PROBLEM_CONTENT;
} {
  return { description, content: PROBLEM_CONTENT };
}
