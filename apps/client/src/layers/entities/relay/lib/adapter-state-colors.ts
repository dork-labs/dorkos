import type { AdapterStatus } from '@dorkos/shared/relay-schemas';
import { STATUS_DOT_PULSE, STATUS_TONE_DOT } from '@/layers/shared/ui';

/**
 * Tailwind classes for the adapter state status dot.
 *
 * Every colour here is a {@link STATUS_TONE_DOT} tone, so an adapter's green is
 * the same green a session, a room and a task draw:
 *
 * - `success` = connected (live)
 * - `neutral` = disconnected (idle, not a warning)
 * - `error` = error
 * - `warning` + pulse = transient (starting, stopping, reconnecting)
 *
 * The pulse is {@link STATUS_DOT_PULSE}, the same constant the identity dots
 * use, rather than a second hand-typed `motion-safe:animate-pulse`.
 */
export const ADAPTER_STATE_DOT_CLASS: Record<AdapterStatus['state'], string> = {
  connected: STATUS_TONE_DOT.success,
  disconnected: STATUS_TONE_DOT.neutral,
  error: STATUS_TONE_DOT.error,
  starting: `${STATUS_TONE_DOT.warning} ${STATUS_DOT_PULSE}`,
  stopping: `${STATUS_TONE_DOT.warning} ${STATUS_DOT_PULSE}`,
  reconnecting: `${STATUS_TONE_DOT.warning} ${STATUS_DOT_PULSE}`,
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
