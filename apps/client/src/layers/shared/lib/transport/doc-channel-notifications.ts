import {
  CanvasChannelNotificationSchema,
  type CanvasChannelNotification,
} from '@dorkos/shared/canvas-channel-schemas';

type Listener = (notification: CanvasChannelNotification) => void;
const listeners = new Set<{ scope: string | undefined; listener: Listener }>();

/** Subscribe by canonical server scope, or across scopes to filter a physical document. */
export function subscribeDocChannelNotifications(
  scope: string | undefined,
  listener: Listener
): () => void {
  const subscription = { scope, listener };
  listeners.add(subscription);
  return () => {
    listeners.delete(subscription);
  };
}

/** Receive a server stream frame; caller-selected request aliases never determine its scope. */
export function publishDocChannelNotification(data: unknown): boolean {
  const parsed = CanvasChannelNotificationSchema.safeParse(data);
  if (!parsed.success) return false;
  for (const subscription of [...listeners]) {
    if (subscription.scope === undefined || subscription.scope === parsed.data.scope) {
      subscription.listener(parsed.data);
    }
  }
  return true;
}

/** Document frames carry their own docSeq and never participate in transcript cursors. */
export function isDocChannelNotificationType(type: string): boolean {
  return type === 'canvas_event' || type === 'canvas_channel_snapshot';
}
