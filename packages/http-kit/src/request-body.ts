/**
 * Request bodies on a Hono chain: parsed once, up front, with a size bound
 * checked before a byte is read.
 *
 * The chain runs `body-parser` (the parser `express.json` is) on the raw Node
 * request. Re-implementing it on `c.req.json()` would quietly change what a
 * client sees for every body that is not plain, well-formed JSON: a limit
 * checked against `Content-Length` before a byte is read, gzip and deflate
 * bodies, a non-UTF charset, a top-level `"string"` refused by strict mode, and
 * an empty body read as `undefined` (no body at all) or `{}` (a chunked body
 * with nothing in it). Each of those has an answer, and a route has to keep
 * giving the same one.
 *
 * The parse happens in the chain, before any credential check, so an oversized
 * POST is refused even when it carries no credential.
 *
 * A route reads the result with {@link readJsonBody}, never `c.req.json()`:
 * the stream is already consumed.
 *
 * @module http-kit/request-body
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import bodyParser from 'body-parser';
import type { Context, MiddlewareHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { HttpBindings } from '@hono/node-server';

/** A Node body parser: `body-parser`'s `json`, `raw` and the like. */
export type NodeBodyParser = (
  req: IncomingMessage,
  res: ServerResponse,
  next: (error?: unknown) => void
) => void;

/**
 * The bounded JSON reader: `body-parser`'s strict JSON parser with a size limit.
 *
 * @param limit - The largest body accepted, in bytes or as `body-parser` reads
 *   a size (`'1mb'`).
 * @returns The parser.
 */
export function jsonBodyParser(limit: number | string): NodeBodyParser {
  return bodyParser.json({ limit });
}

/**
 * A body parser for some requests only, chosen INSTEAD of the chain's default.
 *
 * A route that takes larger uploads brings a larger limit, one that verifies a
 * signature brings a raw parser, and so on.
 */
export interface BodyRule {
  /**
   * Whether this rule parses the request. Match the way an Express mount did:
   * a prefix matches case-insensitively at a segment boundary ({@link underMount}).
   */
  matches(method: string, path: string): boolean;
  /** The parser to run. */
  parse: NodeBodyParser;
  /**
   * Answer a body this rule's parser refused, in the group's own words: the
   * status and JSON body to send. Without it the refusal is thrown to the
   * chain's error handler.
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
 * prefix itself or anything below it, ignoring case.
 *
 * @param path - The request path.
 * @param prefix - The mount path, lower-case, with no trailing slash.
 * @returns Whether the path is under the mount.
 */
export function underMount(path: string, prefix: string): boolean {
  const lowered = path.toLowerCase();
  return lowered === prefix || lowered.startsWith(`${prefix}/`);
}

/** The Hono environment the body stage reads and writes. */
export type RequestBodyEnv = {
  Bindings: HttpBindings;
  Variables: {
    /** What the body stage parsed: `req.body` on an Express chain. */
    body?: unknown;
  };
};

/** Options for {@link parseRequestBody}. */
export interface ParseRequestBodyOptions {
  /** Path-scoped parsers, checked in order; the first match wins. */
  rules?: readonly BodyRule[];
  /** The parser for a request no rule matches, usually {@link jsonBodyParser}. */
  fallback: NodeBodyParser;
}

/**
 * The body stage of a Hono chain: run the first matching rule's parser, or the
 * fallback, on the raw request, and keep what it read as `c.var.body`.
 *
 * A parse failure is thrown (unless the rule answers it), so it reaches the
 * chain's `onError` exactly as a body-parser error reaches an Express error
 * handler.
 *
 * @param options - See {@link ParseRequestBodyOptions}.
 * @returns The middleware.
 */
export function parseRequestBody<E extends RequestBodyEnv>(
  options: ParseRequestBodyOptions
): MiddlewareHandler<E> {
  const rules = options.rules ?? [];
  return async (c, next) => {
    const { incoming, outgoing } = c.env;
    const rule = rules.find((candidate) => candidate.matches(c.req.method, c.req.path));
    const failure = await new Promise<{ error: unknown } | undefined>((resolve, reject) => {
      (rule?.parse ?? options.fallback)(incoming, outgoing, (error) => {
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
   * What a request with no body reads as. The old Express handlers wrote
   * `req.body ?? {}`; pass `{}` here to keep that.
   */
  emptyAs?: unknown;
}

/**
 * The request body the chain parsed, as an Express handler reads `req.body`.
 *
 * Unvalidated: parse it with the route's schema.
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
