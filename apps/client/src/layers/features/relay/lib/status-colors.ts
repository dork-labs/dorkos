import {
  STATUS_TONE_BORDER_LEFT,
  STATUS_TONE_DOT,
  STATUS_TONE_TEXT,
  type StatusTone,
} from '@/layers/shared/ui';

/**
 * What each relay status MEANS, in the app's one status vocabulary.
 *
 * Only the tone lives here. The classes come from the shared records, so relay
 * cannot drift into its own green again — this table used to spell every state
 * out three times (`bg-green-500`, `text-green-600 dark:text-green-400`,
 * `border-l-green-500`) and had already grown an emerald beside the green.
 *
 * `disconnected` is an error here and a plain `neutral` for an adapter
 * (`entities/relay/lib/adapter-state-colors.ts`), which is not drift: a
 * conversation whose peer dropped has a problem, an adapter you never started
 * does not.
 */
export const RELAY_STATUS_TONE = {
  healthy: 'success',
  delivered: 'success',
  connected: 'success',
  pending: 'info',
  starting: 'info',
  new: 'info',
  reconnecting: 'warning',
  degraded: 'warning',
  warning: 'warning',
  rate_limited: 'warning',
  failed: 'error',
  error: 'error',
  disconnected: 'error',
  inactive: 'neutral',
  stopped: 'neutral',
} as const satisfies Record<string, StatusTone>;

export type RelayStatus = keyof typeof RELAY_STATUS_TONE;

/**
 * The tone a relay status speaks in, or `neutral` for one this build has never
 * heard of — an unknown state is not a failure.
 *
 * @param status - Any relay status string (e.g. `'connected'`, `'failed'`)
 */
function toneOf(status: string): StatusTone {
  return RELAY_STATUS_TONE[status as RelayStatus] ?? 'neutral';
}

/**
 * Returns the Tailwind dot (background) color class for a given relay status string.
 *
 * @param status - Any relay status string (e.g. `'connected'`, `'failed'`)
 */
export function getStatusDotColor(status: string): string {
  return STATUS_TONE_DOT[toneOf(status)];
}

/**
 * Returns the Tailwind text color class for a given relay status string.
 *
 * @param status - Any relay status string
 */
export function getStatusTextColor(status: string): string {
  return STATUS_TONE_TEXT[toneOf(status)];
}

/**
 * Returns the Tailwind left-border color class for a given relay status string.
 *
 * @param status - Any relay status string
 */
export function getStatusBorderColor(status: string): string {
  return STATUS_TONE_BORDER_LEFT[toneOf(status)];
}
