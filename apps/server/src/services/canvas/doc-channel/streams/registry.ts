/** Existing HTTP and WebSocket scopes share the production document stream instance. */
import type { Request, Response } from 'express';
import type { CanvasChannelNotification } from '@dorkos/shared/canvas-channel-schemas';
export type DocScopeNotifications = (
  signal: AbortSignal
) => AsyncIterable<CanvasChannelNotification>;
export type DocScopeNotificationsFactory = (
  scope: string,
  req: Pick<Request, 'headers'>,
  res: Pick<Response, 'locals'>
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
  return factory?.(scope, req, res);
}
