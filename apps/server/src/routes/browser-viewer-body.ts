import type { MiddlewareHandler } from 'hono';
import {
  jsonBodyParser,
  parseRequestBody,
  problemBody,
  underMount,
  type BodyRule,
} from '@dorkos/http-kit';
import type { ApiEnv } from '../http/api-chain.js';

const bounded: BodyRule = {
  matches: () => true,
  parse: jsonBodyParser('16kb'),
  answerFailure: () => ({
    status: 400,
    body: problemBody('invalid_request', { detail: 'Reopen the browser view and try again.' }),
  }),
};
/** Defer this group's body until after its strict local-person ingress, including multipart. */
export const browserViewerBodyRule: BodyRule = {
  matches: (_method, path) => underMount(path, '/api/browser-viewers'),
  parse: (_req, _res, next) => next(),
};
/** The group's own bounded JSON stage, run only after the person and local checks pass. */
export const parseViewerJson: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // Only the files handler consumes multipart, after controller/ticket admission.
  if (c.req.header('content-type')?.startsWith('multipart/')) return next();
  return parseRequestBody<ApiEnv>({ rules: [bounded], fallback: bounded.parse })(c, next);
};
