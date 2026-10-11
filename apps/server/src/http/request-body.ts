/**
 * Request bodies on the Hono chain: parsed once, up front, exactly the way the
 * Express chain's `express.json` parses them today.
 *
 * Both chains run `body-parser` (the parser `express.json` is) on the raw Node
 * request. Re-implementing it on `c.req.json()` would quietly change what a
 * client sees for every body that is not plain, well-formed JSON: a 1 MB
 * limit checked against `Content-Length` before a byte is read, gzip and
 * deflate bodies, a non-UTF charset, a top-level `"string"` refused by strict
 * mode, and an empty body read as `undefined` (no body at all) or `{}` (a
 * chunked body with nothing in it). Each of those has an answer today, and a
 * moved route has to give the same one.
 *
 * The parse happens in the chain, before the session gate, because that is
 * where Express does it: an oversized POST is a `413` even when it carries no
 * credential, and a malformed one is a `500` (the error handler maps only the
 * size limit; see `middleware/error-handler.ts`).
 *
 * A route reads the result with {@link readJsonBody}, never `c.req.json()`:
 * the stream is already consumed.
 *
 * @module http/request-body
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import bodyParser from 'body-parser';
import type { Context, MiddlewareHandler } from 'hono';
import type { HttpBindings } from '@hono/node-server';

/** The app-wide JSON body limit, on both chains. */
export const API_JSON_BODY_LIMIT = '1mb';

/** A Node body parser: `body-parser`'s `json`, `raw` and the like. */
type NodeBodyParser = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void
) => void;

/**
 * A body parser for some requests only, chosen INSTEAD of the app-wide one.
 *
 * The Express chain mounts these ahead of `express.json` (a larger limit for
 * feedback screenshots, a smaller one for canvas page events, raw bytes for a
 * signed relay webhook), and `express.json` then skips the body they read. A
 * route group brings its rule to the chain when it moves.
 */
export interface BodyRule {
  /**
   * Whether this rule parses the request. Match the way the Express mount did:
   * an `app.use` prefix matches case-insensitively at a segment boundary.
   */
  matches(method: string, path: string): boolean;
  /** The parser to run. */
  parse: NodeBodyParser;
}

/** The Hono environment the body stage reads and writes. */
export type RequestBodyEnv = {
  Bindings: HttpBindings;
  Variables: {
    /** What the body stage parsed: `req.body` on the Express chain. */
    body?: unknown;
  };
};

const parseJson: NodeBodyParser = bodyParser.json({ limit: API_JSON_BODY_LIMIT });

/**
 * The body stage of the Hono chain: run the first matching rule's parser, or
 * the app-wide JSON parser, on the raw request, and keep what it read as
 * `c.var.body`.
 *
 * A parse failure is thrown, so it reaches the chain's `onError` exactly as a
 * body-parser error reaches the Express error handler.
 *
 * @param rules - Path-scoped parsers, checked in order before the app-wide one.
 * @returns The middleware.
 */
export function parseRequestBody<E extends RequestBodyEnv>(
  rules: readonly BodyRule[] = []
): MiddlewareHandler<E> {
  return async (c, next) => {
    const { incoming, outgoing } = c.env;
    const rule = rules.find((candidate) => candidate.matches(c.req.method, c.req.path));
    await new Promise<void>((resolve, reject) => {
      (rule?.parse ?? parseJson)(incoming, outgoing, (error) =>
        error ? reject(error) : resolve()
      );
    });
    // `body-parser` leaves `body` unset when it read nothing (no body, or a
    // type it does not parse), as Express 5 leaves `req.body` undefined.
    const body = (incoming as IncomingMessage & { body?: unknown }).body;
    if (body !== undefined) c.set('body', body);
    await next();
  };
}

/** Options for {@link readJsonBody}. */
export interface ReadJsonBodyOptions {
  /**
   * What a request with no body reads as. The Express handlers write
   * `req.body ?? {}`; pass `{}` here to keep that.
   */
  emptyAs?: unknown;
}

/**
 * The request body the chain parsed, as an Express handler reads `req.body`.
 *
 * Unvalidated: parse it with the route's schema, as the Express handler does.
 *
 * @param c - The Hono context.
 * @param options - See {@link ReadJsonBodyOptions}.
 * @returns The parsed body, or `options.emptyAs` when there was none.
 */
export function readJsonBody(
  c: Context<RequestBodyEnv>,
  options: ReadJsonBodyOptions = {}
): unknown {
  return c.get('body') ?? options.emptyAs;
}
