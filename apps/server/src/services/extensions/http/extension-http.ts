/**
 * How a running extension answers HTTP: one {@link ExtensionHttpHandler} per
 * extension, which `routes/extension-api.ts` calls for every request under
 * `/api/ext/<id>`.
 *
 * A handler either answers or passes. A request every handler passes on gets
 * the `/api` 404. Each piece an extension can have is one handler, tried in a
 * fixed order ({@link firstAnswer}): its `dataProxy` (`extension-proxy.ts`),
 * then its fetch handler (`fetch-handler.ts`); or, for one that runs in its
 * own process, the forwarder (`isolation/isolated-router.ts`).
 *
 * @module services/extensions/http/extension-http
 */
import type { Context } from 'hono';
import type { ApiEnv } from '../../../http/api-chain.js';

/**
 * The largest request body an extension is handed, in its own process or in
 * the server's: the app-wide JSON limit (`http/request-body.ts`).
 */
export const MAX_FORWARDED_BODY_BYTES = 1024 * 1024;

/** The error a request with a larger body is answered with, as a `413`. */
export const TOO_LARGE = 'That request is too large.';

/** The request an extension handler is given. */
export interface ExtensionRequest {
  /** The Hono context, behind the whole `/api` chain. */
  readonly c: Context<ApiEnv>;
  /** The extension's mount, `/api/ext/<id>`, with the id the route matched. */
  readonly mount: string;
  /**
   * The path below the mount, starting with `/`: still percent-encoded, with
   * dot segments resolved, as the route matched it.
   */
  readonly subPath: string;
}

/**
 * One running extension's HTTP surface: a `Response` when it answered, or
 * `null` when it passes the request on.
 */
export type ExtensionHttpHandler = (request: ExtensionRequest) => Promise<Response | null>;

/**
 * A handler that asks each of `handlers` in order and keeps the first answer.
 *
 * @param handlers - The handlers, in order; `null` entries are skipped.
 * @returns The combined handler.
 */
export function firstAnswer(
  ...handlers: ReadonlyArray<ExtensionHttpHandler | null | undefined>
): ExtensionHttpHandler {
  const present = handlers.filter((handler): handler is ExtensionHttpHandler => !!handler);
  return async (request) => {
    for (const handler of present) {
      const answer = await handler(request);
      if (answer) return answer;
    }
    return null;
  };
}
