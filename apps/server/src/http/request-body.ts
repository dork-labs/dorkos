/**
 * The app chain's body stage: `@dorkos/http-kit`'s bounded body reader with
 * this server's limits.
 *
 * Every body is parsed once, up front, before the session gate, because that
 * is where Express did it: an oversized POST is a `413` even when it carries no
 * credential, and a malformed one a `400`, each a problem document (the error
 * handler maps the parser's refusals; see `middleware/error-handler.ts`). A route reads the result with
 * `readJsonBody` from `@dorkos/http-kit`.
 *
 * @module http/request-body
 */
import {
  jsonBodyParser,
  parseRequestBody,
  underMount,
  type BodyRule,
  type RequestBodyEnv,
} from '@dorkos/http-kit';
import type { MiddlewareHandler } from 'hono';
import { MCP_MAX_REQUEST_BODY_BYTES } from '../services/core/capabilities/mcp-input/limits.js';

/** The app-wide JSON body limit. */
const API_JSON_BODY_LIMIT = '1mb';

/** MCP is capped before parsing and auth as well as at the transport's raw-body seam. */
const MCP_BODY_RULE: BodyRule = {
  matches: (_method, path) => underMount(path, '/mcp'),
  parse: jsonBodyParser(MCP_MAX_REQUEST_BODY_BYTES),
};

const parseApiJson = jsonBodyParser(API_JSON_BODY_LIMIT);

/**
 * The app chain's body stage: the first matching rule's parser, then the MCP
 * limit under `/mcp`, then the app-wide 1 MB JSON parser.
 *
 * @param rules - Path-scoped parsers, checked in order before the defaults.
 * @returns The middleware.
 */
export function apiRequestBody<E extends RequestBodyEnv>(
  rules: readonly BodyRule[] = []
): MiddlewareHandler<E> {
  return parseRequestBody<E>({ rules: [...rules, MCP_BODY_RULE], fallback: parseApiJson });
}
