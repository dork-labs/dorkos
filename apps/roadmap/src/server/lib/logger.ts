/**
 * Simple logger for the roadmap server.
 *
 * Wraps console methods with a `[roadmap]` prefix for easy log filtering.
 *
 * @module server/lib/logger
 */
export const logger = {
  info: (...args: unknown[]) => console.log('[roadmap]', ...args),
  warn: (...args: unknown[]) => console.warn('[roadmap]', ...args),
  error: (...args: unknown[]) => console.error('[roadmap]', ...args),
};
