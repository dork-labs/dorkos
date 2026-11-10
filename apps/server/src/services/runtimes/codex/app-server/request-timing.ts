import type { StreamEvent } from '@dorkos/shared/types';
import type { ServerNotification } from './protocol/methods.js';
const lastReadings = new WeakMap<object, string>();

/** Codex exposes last-request counts but no request id or request-level clock boundaries. */
export function codexRequestUsage(owner: object, event: ServerNotification): StreamEvent[] {
  if (event.method !== 'thread/tokenUsage/updated') return [];
  const params = event.params as {
    tokenUsage?: { last?: Record<string, number>; total?: Record<string, number> };
  };
  const usage = params.tokenUsage?.last;
  if (!usage || (typeof usage.inputTokens !== 'number' && typeof usage.outputTokens !== 'number'))
    return [];
  const key = JSON.stringify(params.tokenUsage);
  if (lastReadings.get(owner) === key) return [];
  lastReadings.set(owner, key);
  return [
    {
      type: 'model_request',
      data: {
        phase: 'usage',
        ...(typeof usage.inputTokens === 'number' ? { inputTokens: usage.inputTokens } : {}),
        ...(typeof usage.outputTokens === 'number'
          ? { outputTokens: usage.outputTokens + (usage.reasoningOutputTokens ?? 0) }
          : {}),
      },
    },
  ];
}

/** Prefer Codex's native item timestamps; absent fields use a local observation. */
export function codexNotificationTime(event: ServerNotification, fallback: () => number): number {
  const params = event.params as Record<string, unknown>;
  const value = event.method === 'item/started' ? params.startedAtMs : params.completedAtMs;
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback();
}
