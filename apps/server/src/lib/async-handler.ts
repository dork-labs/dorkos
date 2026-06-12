/**
 * Express 4 async-rejection guard.
 *
 * Express 4 does not forward rejected promises from async route handlers to
 * the error middleware — an uncaught rejection (e.g. a
 * `RuntimeNotRegisteredError` from `runtimeRegistry.resolveForSession`) leaves
 * the request hanging until the client times out. Wrapping every async handler
 * in {@link asyncHandler} closes that class structurally instead of relying on
 * per-handler `try { … } catch (err) { next(err) }` boilerplate.
 *
 * Handlers that map specific failures to specific status codes keep their own
 * narrower `try`/`catch`; this wrapper is the safety net for everything they
 * do not catch. Express 5 forwards async rejections natively, at which point
 * this module can be deleted.
 *
 * @module lib/async-handler
 */
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import type { ParamsDictionary, Query } from 'express-serve-static-core';

/**
 * Wrap an async route handler so a rejected promise is forwarded to `next()`
 * (the error middleware) instead of hanging the request.
 *
 * Generic over the Express handler type parameters (defaulted to Express's own
 * defaults) so route-path param inference (`req.params`) survives the wrap.
 *
 * @param fn - The async handler to guard
 * @returns A standard Express handler that never leaks an unhandled rejection
 */
export function asyncHandler<
  P = ParamsDictionary,
  ResBody = unknown,
  ReqBody = unknown,
  ReqQuery = Query,
>(
  fn: (
    req: Request<P, ResBody, ReqBody, ReqQuery>,
    res: Response<ResBody>,
    next: NextFunction
  ) => Promise<unknown>
): RequestHandler<P, ResBody, ReqBody, ReqQuery> {
  return (req, res, next) => {
    fn(req, res, next).catch(next);
  };
}
