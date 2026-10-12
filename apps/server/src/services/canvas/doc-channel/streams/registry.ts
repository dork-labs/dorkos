/** Existing HTTP and WebSocket scopes share the production document stream instance. */
import type { Request, Response } from 'express';
import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';
import type { RequestFacts } from '../../../../http/request-facts.js';
/** Privileged projection rechecks its captured authority at the actual wire boundary. */
export interface DocScopeNotificationStream extends AsyncIterable<CanvasChannelNotification> {
  prepareForSend(notification: CanvasChannelNotification): CanvasChannelNotification;
}
export type DocScopeNotifications = (signal: AbortSignal) => DocScopeNotificationStream;
/** Who is subscribing: the raw agent header and what the chain resolved. */
export type DocScopeCaller = Pick<RequestFacts, 'headers' | 'agentIdentity' | 'user'>;
export type DocScopeNotificationsFactory = (
  scope: string,
  caller: DocScopeCaller
) => DocScopeNotifications;
let factory: DocScopeNotificationsFactory | undefined;
/** Install once at server composition, after current ownership/principal authority is available. */
export function setDocScopeNotificationsFactory(
  value: DocScopeNotificationsFactory | undefined
): void {
  factory = value;
}
/** Preserve the request's actual authority facts; never substitute a default operator. */
export function docScopeNotifications(
  scope: string,
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>
): DocScopeNotifications | undefined {
  return factory?.(scope, {
    headers: req.headers,
    agentIdentity: res.locals.agentIdentity,
    user: res.locals.user,
  });
}
