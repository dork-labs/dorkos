/** Format a duration in ms using tiered display: <100ms / 347ms / 1.2s / 14s / 1m 23s */
export function formatDuration(ms: number): string {
  if (ms < 100) return '<100ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}
