import { logger } from '../lib/logger.js';
import { redactMediaTicket } from '../services/extensions/http/media-tickets.js';

/**
 * Log one finished HTTP request.
 *
 * Logs 4xx/5xx responses at warn level (visible in production) and successful
 * responses at debug level. Takes only the method, path, status and timing:
 * never a body (may contain user messages) or headers (may contain auth
 * tokens). A video link's ticket is written as `[ticket]`, since the ticket is
 * the capability (DOR-4321). The chain (`http/api-chain.ts`) writes it once
 * each response finishes.
 *
 * @param method - The request method.
 * @param path - The request path, without the query string.
 * @param status - The status that went out.
 * @param ms - How long the request took, in milliseconds.
 */
export function logRequest(method: string, path: string, status: number, ms: number): void {
  const meta = { method, path: redactMediaTicket(path), status, ms };
  if (status >= 400) {
    logger.warn(meta, 'request');
  } else {
    logger.debug(meta, 'request');
  }
}
