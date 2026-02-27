/** Unified status color tokens for all Relay components. */
export const RELAY_STATUS_COLORS = {
  healthy:      { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', border: 'border-l-green-500' },
  delivered:    { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', border: 'border-l-green-500' },
  connected:    { dot: 'bg-green-500', text: 'text-green-600 dark:text-green-400', border: 'border-l-green-500' },
  pending:      { dot: 'bg-blue-500',  text: 'text-blue-600 dark:text-blue-400',   border: 'border-l-blue-500' },
  starting:     { dot: 'bg-blue-500',  text: 'text-blue-600 dark:text-blue-400',   border: 'border-l-blue-500' },
  new:          { dot: 'bg-blue-500',  text: 'text-blue-600 dark:text-blue-400',   border: 'border-l-blue-500' },
  degraded:     { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', border: 'border-l-amber-500' },
  warning:      { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', border: 'border-l-amber-500' },
  rate_limited: { dot: 'bg-amber-500', text: 'text-amber-600 dark:text-amber-400', border: 'border-l-amber-500' },
  failed:       { dot: 'bg-red-500',   text: 'text-red-600 dark:text-red-400',     border: 'border-l-red-500' },
  error:        { dot: 'bg-red-500',   text: 'text-red-600 dark:text-red-400',     border: 'border-l-red-500' },
  disconnected: { dot: 'bg-red-500',   text: 'text-red-600 dark:text-red-400',     border: 'border-l-red-500' },
  inactive:     { dot: 'bg-gray-400',  text: 'text-muted-foreground',              border: 'border-l-gray-400' },
  stopped:      { dot: 'bg-gray-400',  text: 'text-muted-foreground',              border: 'border-l-gray-400' },
} as const;

export type RelayStatus = keyof typeof RELAY_STATUS_COLORS;

/**
 * Returns the Tailwind dot (background) color class for a given relay status string.
 * Falls back to `bg-gray-400` for unknown statuses.
 *
 * @param status - Any relay status string (e.g. `'connected'`, `'failed'`)
 */
export function getStatusDotColor(status: string): string {
  return RELAY_STATUS_COLORS[status as RelayStatus]?.dot ?? 'bg-gray-400';
}

/**
 * Returns the Tailwind text color class for a given relay status string.
 * Falls back to `text-muted-foreground` for unknown statuses.
 *
 * @param status - Any relay status string
 */
export function getStatusTextColor(status: string): string {
  return RELAY_STATUS_COLORS[status as RelayStatus]?.text ?? 'text-muted-foreground';
}

/**
 * Returns the Tailwind left-border color class for a given relay status string.
 * Falls back to `border-l-gray-400` for unknown statuses.
 *
 * @param status - Any relay status string
 */
export function getStatusBorderColor(status: string): string {
  return RELAY_STATUS_COLORS[status as RelayStatus]?.border ?? 'border-l-gray-400';
}
