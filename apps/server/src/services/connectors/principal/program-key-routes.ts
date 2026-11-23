/**
 * The connector routes that only a personal API key may call: a script's own
 * door to the connected apps it was granted. Each one refuses a request that
 * does not prove a key (`CONNECTOR_PROGRAM_CREDENTIAL_REQUIRED` or
 * `connector_program_credential_required`, `401`), even from this computer
 * with no password asked, because the key is what names the program.
 *
 * The routers register these routes from this list (`routes/connector-execution.ts`,
 * `routes/connector-management.ts`), and the OpenAPI document marks the same
 * operations as API-key only (`services/core/openapi/security-schemes.ts`), so
 * the two cannot drift.
 *
 * @module services/connectors/principal/program-key-routes
 */

/** Where the connector routes are mounted. */
export const CONNECTORS_MOUNT = '/api/connectors';

/** One route only a personal API key may call, relative to {@link CONNECTORS_MOUNT}. */
export interface ProgramKeyRoute {
  /** The HTTP method, upper-case, as `Hono#on` takes it. */
  readonly method: 'GET' | 'POST';
  /** The router path, with `:param` segments. */
  readonly path: string;
}

/** Every connector route only a personal API key may call, by name. */
export const PROGRAM_KEY_ROUTES = {
  accessible: { method: 'GET', path: '/accessible' },
  accessibleOperations: { method: 'GET', path: '/accessible/:connectionId/operations' },
  accessibleSubscriptions: { method: 'GET', path: '/accessible/subscriptions' },
  executions: { method: 'POST', path: '/executions' },
  cliExecutions: { method: 'POST', path: '/cli/executions' },
  agentUsage: { method: 'GET', path: '/usage/agent' },
  programReview: { method: 'GET', path: '/program/reviews/:reviewRequestId' },
} as const satisfies Record<string, ProgramKeyRoute>;

/**
 * The same routes as `METHOD /api/...` keys in OpenAPI form (`{param}`), as
 * the document lists its operations.
 */
export function programKeyOperationKeys(): Set<string> {
  return new Set(
    Object.values(PROGRAM_KEY_ROUTES).map(
      ({ method, path }) => `${method} ${CONNECTORS_MOUNT}${path.replace(/:([^/]+)/g, '{$1}')}`
    )
  );
}
