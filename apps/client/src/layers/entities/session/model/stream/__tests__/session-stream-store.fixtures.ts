/** Shared fixtures for the session-stream-store test files. */
import type { HistoryMessage } from '@dorkos/shared/types';
import type { SessionEvent, SessionSnapshot, SessionStatus } from '@dorkos/shared/session-stream';
import type { MessageDeliveryOutcome, QueuedMessage } from '@dorkos/shared/schemas';

/** The session id every store test uses. */
export const SID = 'sess-1';

/** A settled status with non-zero usage, for snapshot hydration. */
export const STATUS: SessionStatus = {
  contextUsage: {
    totalTokens: 100,
    maxTokens: 200,
    outputTokens: 10,
    cacheReadTokens: 5,
    cacheCreationTokens: 2,
  },
  cost: 0.01,
  usage: null,
  cacheStats: { cacheReadTokens: 5, cacheCreationTokens: 2 },
  model: 'claude',
  permissionMode: 'default',
  todoCounts: null,
  runningSubagentCount: 0,
  lifecycle: 'idle',
  lastError: null,
  limit: null,
  accountUsage: null,
};

/** The one user message a default snapshot carries. */
export const MESSAGE: HistoryMessage = { id: 'm1', role: 'user', content: 'hello' };

/** Build a snapshot at cursor 5 holding {@link MESSAGE}. */
export function snapshot(overrides: Partial<SessionSnapshot> = {}): SessionSnapshot {
  return {
    messages: [MESSAGE],
    inProgressTurn: null,
    status: STATUS,
    pendingInteractions: [],
    queuedMessages: [],
    canvas: [],
    cursor: 5,
    ...overrides,
  };
}

/** Build one queued message. */
export function queued(id: string, content: string): QueuedMessage {
  return { id, content, disposition: 'queue', enqueuedAt: 1000, enqueuedBy: 'window-a' };
}

/** Build a `queue_update` event. */
export function queueUpdate(
  seq: number,
  queue: QueuedMessage[],
  outcome?: MessageDeliveryOutcome
): SessionEvent {
  return { type: 'queue_update', seq, queue, ...(outcome ? { outcome } : {}) };
}

/** Build an `approval_required` event for a Bash tool. */
export function approvalEvent(seq: number, id: string): SessionEvent {
  return {
    type: 'approval_required',
    seq,
    startedAt: 1000,
    remainingMs: 30000,
    id,
    toolName: 'Bash',
    input: 'ls',
    hasSuggestions: false,
  };
}
