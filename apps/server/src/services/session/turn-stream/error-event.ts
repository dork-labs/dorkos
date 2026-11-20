import type { ErrorCategory } from '@dorkos/shared/schemas';
import type { SessionEvent } from '@dorkos/shared/session-stream';
/** Preserve typed failure and server dispatch correlation through the normalizer. */
export function normalizedErrorEvent(
  data: Record<string, unknown>
): Omit<Extract<SessionEvent, { type: 'error' }>, 'seq'> {
  return {
    type: 'error',
    message: String(data.message ?? 'Unknown error'),
    ...(data.code !== undefined ? { code: String(data.code) } : {}),
    ...(data.reason !== undefined ? { reason: String(data.reason) } : {}),
    ...(typeof data.sourceDispatchId === 'string'
      ? { sourceDispatchId: data.sourceDispatchId }
      : {}),
    ...(data.category !== undefined ? { category: data.category as ErrorCategory } : {}),
    ...(data.details !== undefined ? { details: String(data.details) } : {}),
  };
}
