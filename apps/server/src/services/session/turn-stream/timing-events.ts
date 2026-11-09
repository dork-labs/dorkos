import { ModelRequestEventSchema } from '@dorkos/shared/schemas';
import type { RawSessionEvent } from '../session-state-projector.js';

/** Copy only finite epoch-ms observations, preserving missing values. */
export function timingPayload(data: { startedAt?: unknown; endedAt?: unknown }): {
  startedAt?: number;
  endedAt?: number;
} {
  const times: { startedAt?: number; endedAt?: number } = {};
  for (const key of ['startedAt', 'endedAt'] as const) {
    const value = data[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) times[key] = value;
  }
  return times;
}

/** A malformed timing event is dropped instead of failing a running turn. */
export function modelRequestPayload(data: unknown): RawSessionEvent | null {
  const parsed = ModelRequestEventSchema.safeParse(data);
  return parsed.success ? { type: 'model_request', ...parsed.data } : null;
}
