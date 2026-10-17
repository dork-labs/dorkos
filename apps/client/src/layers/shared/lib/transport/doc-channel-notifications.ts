import type { Transport } from '@dorkos/shared/transport';
import {
  CanvasChannelNotificationSchema,
  type CanvasChannelNotification,
} from '@dorkos/shared/canvas-channel-schemas';
import { currentDocChannelConnection } from './doc-channel-ownership';

type Listener = (notification: CanvasChannelNotification) => void;
const listeners = new Set<{
  scope: string | undefined;
  listener: Listener;
  owner?: Transport;
  onRetire?: () => void;
}>();
/** Owner qualification precedes each callback; a retired connection cannot reach the next listener. */
export function subscribeDocChannelNotifications(
  scope: string | undefined,
  listener: Listener,
  owner?: Transport,
  onRetire?: () => void
): () => void {
  const subscription = { scope, listener, owner, onRetire };
  listeners.add(subscription);
  return () => {
    listeners.delete(subscription);
  };
}
/** Internal opaque connection proof, never a public DTO publisher. */
export function publishOwnedDocChannelNotification(ticket: object, data: unknown): boolean {
  const owner = currentDocChannelConnection(ticket);
  if (!owner) return false;
  const parsed = CanvasChannelNotificationSchema.safeParse(data);
  if (!parsed.success || currentDocChannelConnection(ticket) !== owner) return false;
  for (const subscription of [...listeners]) {
    if (currentDocChannelConnection(ticket) !== owner) return false;
    if (!listeners.has(subscription)) continue;
    if (
      (subscription.owner === undefined || subscription.owner === owner) &&
      (subscription.scope === undefined || subscription.scope === parsed.data.scope)
    ) {
      subscription.listener(parsed.data);
      if (currentDocChannelConnection(ticket) !== owner) return false;
    }
  }
  return true;
}
/** Recognize document frames on an existing owned stream. */
export function isDocChannelNotificationType(type: string): boolean {
  return type === 'canvas_event' || type === 'canvas_channel_snapshot';
}

/** Admission is already cleared before these observable lifecycle callbacks run. */
export function notifyDocChannelRetirement(owner: Transport): void {
  for (const subscription of [...listeners]) {
    if (!listeners.has(subscription) || subscription.owner !== owner) continue;
    try {
      subscription.onRetire?.();
    } catch {
      /* One subscriber cannot keep siblings current or prevent physical teardown. */
    }
  }
}
