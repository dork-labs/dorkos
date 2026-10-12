/**
 * How a running extension answers HTTP: one {@link ExtensionHttpHandler} per
 * extension, which `routes/extension-api.ts` calls for every request under
 * `/api/ext/<id>`.
 *
 * A handler either answers or passes. A request every handler passes on gets
 * the `/api` 404, as it did when the extension's Express router called
 * `next()` and the request fell through to the rest of the server. Each piece
 * an extension can have is one handler, tried in a fixed order
 * ({@link firstAnswer}): its own Express router, through the bridge
 * (`express-bridge.ts`); its `dataProxy` (`extension-proxy.ts`); or, for one
 * that runs in its own process, the forwarder (`isolation/isolated-router.ts`).
 *
 * @module services/extensions/http/extension-http
 */
import type { Context } from 'hono';
import type { ApiEnv } from '../../../http/api-chain.js';

/** The request an extension handler is given. */
export interface ExtensionRequest {
  /** The Hono context, behind the whole `/api` chain. */
  readonly c: Context<ApiEnv>;
  /** The extension's mount as the request named it: `/api/ext/<id>`. */
  readonly mount: string;
  /** The path below the mount, as sent (still percent-encoded), starting with `/`. */
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
