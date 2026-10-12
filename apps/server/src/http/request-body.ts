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
import type { ContentfulStatusCode } from 'hono/utils/http-status';
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
 * Feedback brings a larger limit for its screenshots and document events a
 * smaller one for page envelopes (`http/hono-api.ts` hands both over). The
 * Express chain still mounts one of its own ahead of `express.json`, raw bytes
 * for a signed relay webhook; a route group brings its rule here when it moves.
 */
export interface BodyRule {
  /**
   * Whether this rule parses the request. Match the way the Express mount did:
   * an `app.use` prefix matches case-insensitively at a segment boundary.
   */
  matches(method: string, path: string): boolean;
  /** The parser to run. */
  parse: NodeBodyParser;
  /**
   * Answer a body this rule's parser refused, in the group's own words: the
   * status and JSON body to send. Without it the refusal is thrown to the
   * chain's error handler, as the app-wide parser's is.
   */
  answerFailure?: (error: unknown, request: RefusedBodyRequest) => RefusedBodyAnswer;
}

/** The request a {@link BodyRule} refused the body of. */
export interface RefusedBodyRequest {
  /** The request method. */
  method: string;
  /** The request path. */
  path: string;
  /** The raw response, to watch it go out. */
  outgoing: ServerResponse;
}

/** What a {@link BodyRule} answers a body it refused with. */
export interface RefusedBodyAnswer {
  /** The status. */
  status: ContentfulStatusCode;
  /** The JSON body. */
  body: object;
}

/**
 * Whether a path falls under an Express-style `app.use(prefix)` mount: the
 * prefix itself or anything below it, ignoring case. A {@link BodyRule} matches
 * this way, as the Express parser it replaces did.
 *
 * @param path - The request path.
 * @param prefix - The mount path, lower-case, with no trailing slash.
 */
export function underMount(path: string, prefix: string): boolean {
  const lowered = path.toLowerCase();
  return lowered === prefix || lowered.startsWith(`${prefix}/`);
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
    const failure = await new Promise<{ error: unknown } | undefined>((resolve, reject) => {
      (rule?.parse ?? parseJson)(incoming, outgoing, (error) => {
        if (!error) resolve(undefined);
        else if (rule?.answerFailure) resolve({ error });
        else reject(error);
      });
    });
    if (failure) {
      const { method, path } = c.req;
      const answer = rule!.answerFailure!(failure.error, { method, path, outgoing });
      return c.json(answer.body, answer.status);
    }
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
