import type { AdapterStatus } from '@dorkos/shared/relay-schemas';

/**
 * Tailwind classes for the adapter state status dot.
 *
 * Color semantics:
 * - green = connected (live)
 * - gray (muted-foreground) = disconnected (idle, not a warning)
 * - red = error
 * - amber + pulse = transient (starting, stopping, reconnecting)
 */
export const ADAPTER_STATE_DOT_CLASS: Record<AdapterStatus['state'], string> = {
  connected: 'bg-green-500',
  disconnected: 'bg-muted-foreground',
  error: 'bg-red-500',
  starting: 'bg-amber-500 motion-safe:animate-pulse',
  stopping: 'bg-amber-500 motion-safe:animate-pulse',
  reconnecting: 'bg-amber-500 motion-safe:animate-pulse',
};

/** Humanized label for a raw adapter state, suitable for UI display. */
export const ADAPTER_STATE_LABEL: Record<AdapterStatus['state'], string> = {
  connected: 'Connected',
  disconnected: 'Ready',
  error: 'Error',
  starting: 'Connecting\u2026',
  stopping: 'Stopping\u2026',
  reconnecting: 'Reconnecting\u2026',
};
