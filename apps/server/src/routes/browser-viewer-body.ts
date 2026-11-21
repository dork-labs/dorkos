import bodyParser from 'body-parser';
import type { MiddlewareHandler } from 'hono';
import type { ApiEnv } from '../http/api-chain.js';
import { parseRequestBody, underMount, type BodyRule } from '../http/request-body.js';

const bounded: BodyRule = {
  matches: () => true,
  parse: bodyParser.json({ limit: '16kb' }),
  answerFailure: () => ({
    status: 400,
    body: { code: 'viewer_bad_request', error: 'Reopen the browser view and try again.' },
  }),
};
/** Defer this group's body until after its strict local-person ingress, including multipart. */
export const browserViewerBodyRule: BodyRule = {
  matches: (_method, path) => underMount(path, '/api/browser-viewers'),
  parse: (_req, _res, next) => next(),
};
export const parseViewerJson: MiddlewareHandler<ApiEnv> = async (c, next) => {
  // Only the files handler consumes multipart, after controller/ticket admission.
  if (c.req.header('content-type')?.startsWith('multipart/')) return next();
  return parseRequestBody<ApiEnv>([bounded])(c, next);
};
