/**
 * The audit log's safety net for mutating HTTP requests (spec `audit-trail`
 * §6.2, PR2 review).
 *
 * Every write DorkOS can be asked to do over HTTP should leave a line in the
 * audit log. The choke points (the capability registry, config writes, package
 * changes, room merges, …) write a precise one. A route with none of those
 * behind it would write nothing, and an agent can call any route. So every
 * `POST`, `PUT`, `PATCH` and `DELETE` under `/api` that finished WITHOUT
 * anything being recorded under its audit scope gets one generic row: who,
 * which method, which route, and how it came out. Never the body and never the
 * query string, and id-shaped path segments are written as `:id`.
 *
 * Deduplication rides the request's audit scope: `AuditLog.record` marks the
 * scope `recorded`, so a request a choke point already covered adds nothing.
 *
 * Two kinds of request are left out, so the log stays a record of actions:
 *
 * - **Conversation.** Sending a chat message, posting in a room, reacting,
 *   starting a thread, attaching a file to a message, editing what is queued.
 *   Those are things said, not things done, and a person's private chat must
 *   not surface as rows anyone in the space can read. The ACTIONS an agent
 *   takes in a conversation are recorded where they happen.
 * - **Requests that change nothing anybody would look for**: a read marker, a
 *   preview, a check, a heartbeat, the devtools stream.
 *
 * What a row does keep: the route with id-shaped segments written as `:id`.
 * Other segments stay as they are, so a package name or the NAME of a secret
 * setting can appear; a secret's value never travels in a path.
 *
 * @module middleware/audit-request-fallback
 */
import type { NextFunction, Request, Response } from 'express';
import type { AuditOperation, AuditOutcome } from '@dorkos/shared/audit-schemas';
import type { AuditActorContext } from '../services/audit/audit-context.js';
import { recordAudit } from '../services/audit/audit-trail.js';

/** The methods that change something, and the operation each records as. */
const MUTATING: Record<string, AuditOperation> = {
  POST: 'execute',
  PUT: 'modify',
  PATCH: 'modify',
  DELETE: 'remove',
};

/**
 * Conversation: what people and agents say, not what they do (see the module
 * doc). Matched on the raw path, before ids are masked.
 */
const CONVERSATION: readonly RegExp[] = [
  /^\/api\/sessions\/[^/]+\/messages$/,
  /^\/api\/sessions\/[^/]+\/queue(?:\/[^/]+)?$/,
  /^\/api\/rooms\/[^/]+\/(?:entries|threads|attachments)$/,
  /^\/api\/rooms\/[^/]+\/entries\/[^/]+\/reactions$/,
  /^\/api\/communities\/[^/]+\/rooms\/[^/]+\/(?:entries|attachments)$/,
];

/**
 * Requests that change nothing anybody would look for in an audit log. Each
 * is either a read sent as a POST, a check, or a marker of what a person has
 * seen; listing them keeps the log a record of actions.
 */
const NOT_ACTIONS: readonly RegExp[] = [
  /\/devtools\/ingest$/,
  /\/preview$/,
  /\/previews$/,
  /\/check-files$/,
  /\/check$/,
  /\/probe$/,
  /\/heartbeat$/,
  /\/read$/,
  /\/read-all$/,
  /\/read-cursor$/,
];

/** A path segment that names one thing rather than a kind of thing. */
const ID_SEGMENT =
  /^(?:\d+|[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{16,}|.{40,})$/i;

/**
 * A request path with its ids written as `:id`, so a row names the route
 * without carrying whatever an id-shaped segment held.
 *
 * @param path - The request path, without its query string.
 */
export function routePatternOf(path: string): string {
  return path
    .split('/')
    .map((segment) => (segment && ID_SEGMENT.test(segment) ? ':id' : segment))
    .join('/');
}

/** How a response status reads as an outcome. */
function outcomeOf(status: number): AuditOutcome {
  if (status < 400) return 'ok';
  if (status === 401 || status === 403 || status === 409 || status === 429) return 'refused';
  return 'failed';
}

/**
 * The fallback row for one request, ready to write once its response has
 * finished, or `undefined` when the request is not one the fallback records.
 *
 * Shared by the Express middleware below and the Hono chain
 * (`http/api-chain.ts`). Each calls the returned function from the Node
 * response's `finish` event with the status that went out.
 *
 * @param method - The request method.
 * @param url - The request URL as sent (path and query).
 * @param scope - The request's audit scope, from `auditActor`.
 * @returns A function taking the final status, or `undefined`.
 */
export function auditFallbackFor(
  method: string,
  url: string,
  scope: AuditActorContext | undefined
): ((status: number) => void) | undefined {
  const operation = MUTATING[method];
  const path = url.split('?')[0] ?? url;
  if (
    !operation ||
    !scope ||
    !path.startsWith('/api/') ||
    CONVERSATION.some((re) => re.test(path)) ||
    NOT_ACTIONS.some((re) => re.test(path))
  ) {
    return undefined;
  }
  return (status) => {
    if (scope.recorded) return;
    const route = routePatternOf(path);
    // The scope is passed explicitly: `finish` fires from the socket, outside
    // the request's own async chain.
    recordAudit({
      actor: scope.actor,
      source: {
        surface: scope.surface,
        ...(scope.sessionId ? { sessionId: scope.sessionId } : {}),
      },
      ...(scope.credential ? { credential: scope.credential } : {}),
      action: `http.${method.toLowerCase()}`,
      operation,
      target: { type: 'route', id: route, name: `${method} ${route}` },
      outcome: outcomeOf(status),
      ...(status >= 400 ? { error: `HTTP ${status}` } : {}),
      summary: `${method} ${route} (${status})`,
    });
  };
}

/**
 * Express middleware: record a mutating `/api` request nothing else recorded
 * ({@link auditFallbackFor}). Mounted right after `auditActor`, whose scope it
 * reads.
 *
 * @param req - The request.
 * @param res - The response.
 * @param next - The next handler.
 */
export function auditRequestFallback(req: Request, res: Response, next: NextFunction): void {
  const record = auditFallbackFor(
    req.method,
    req.originalUrl,
    res.locals.auditScope as AuditActorContext | undefined
  );
  if (record) res.on('finish', () => record(res.statusCode));
  next();
}
