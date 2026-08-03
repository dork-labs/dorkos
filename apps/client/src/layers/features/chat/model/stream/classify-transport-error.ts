/**
 * Transport error classification for structured banner display.
 *
 * @module features/chat/model/classify-transport-error
 */
import { TIMING } from '@/layers/shared/lib';
import type { TransportErrorInfo } from '../chat-types';

/**
 * Classify a transport-level error for structured banner display.
 *
 * @internal Exported for testing only.
 */
export function classifyTransportError(err: unknown): TransportErrorInfo {
  const error = err instanceof Error ? err : new Error(String(err));
  const code = (err as { code?: string } | null | undefined)?.code;
  const status = (err as { status?: number } | null | undefined)?.status;

  // Session locked by another client
  if (code === 'SESSION_LOCKED') {
    return {
      heading: 'Session in use',
      message: 'Another client is sending a message. Try again in a few seconds.',
      retryable: false,
      autoDismissMs: TIMING.SESSION_BUSY_CLEAR_MS,
    };
  }

  // Network/fetch errors
  if (error instanceof TypeError || /fetch|network/i.test(error.message)) {
    return {
      heading: "Can't reach DorkOS",
      message: 'Could not reach the server. Check your network and try again.',
      retryable: true,
    };
  }

  // HTTP 500-599 server errors
  if (status && status >= 500 && status <= 599) {
    return {
      heading: 'Server error',
      message: 'The server encountered an error. Try again.',
      retryable: true,
    };
  }

  // HTTP 408 or timeout
  if (status === 408 || /timeout/i.test(error.message)) {
    return {
      heading: 'Request timed out',
      message: 'The server took too long to respond. Try again.',
      retryable: true,
    };
  }

  // Default unknown
  return {
    heading: 'Error',
    message: error.message,
    retryable: false,
  };
}
