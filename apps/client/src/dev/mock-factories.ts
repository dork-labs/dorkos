import type {
  ChatMessage,
  ToolCallState,
  HookState,
} from '@/layers/features/chat/model/chat-types';
import type { PendingFile } from '@/layers/features/chat/model/use-file-upload';
import type { QueueItem } from '@/layers/features/chat/model/use-message-queue';
import type { TaskItem } from '@dorkos/shared/types';

/** Shared mock session ID for playground demos that require a session context. */
export const MOCK_SESSION_ID = 'playground-session-001';

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

let idCounter = 0;
function nextId(prefix = 'mock') {
  return `${prefix}-${++idCounter}`;
}

/** Create a user message with sensible defaults. */
export function createUserMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = nextId('user');
  const content = overrides.content ?? 'Hello, can you help me?';
  return {
    id,
    role: 'user',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create an assistant message with sensible defaults. */
export function createAssistantMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  const id = nextId('asst');
  const content = overrides.content ?? 'Sure, I can help with that.';
  return {
    id,
    role: 'assistant',
    content,
    parts: [{ type: 'text', text: content }],
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

/** Create a tool call with sensible defaults. */
export function createToolCall(overrides: Partial<ToolCallState> = {}): ToolCallState {
  return {
    toolCallId: nextId('tc'),
    toolName: 'Read',
    input: JSON.stringify({ file_path: '/src/index.ts' }),
    status: 'complete',
    ...overrides,
  };
}

/** Create a task item with sensible defaults. */
export function createTaskItem(overrides: Partial<TaskItem> = {}): TaskItem {
  return {
    id: nextId('task'),
    subject: 'Implement feature',
    status: 'pending',
    ...overrides,
  };
}

/** Create a pending file with sensible defaults. */
export function createPendingFile(overrides: Partial<PendingFile> = {}): PendingFile {
  const id = nextId('file');
  return {
    id,
    file: new File(['content'], overrides.file?.name ?? 'document.txt', {
      type: overrides.file?.type ?? 'text/plain',
    }),
    status: 'pending',
    progress: 0,
    ...overrides,
  };
}

/** Create a queue item with sensible defaults. */
export function createQueueItem(overrides: Partial<QueueItem> = {}): QueueItem {
  return {
    id: nextId('q'),
    content: 'Follow-up message',
    ...overrides,
  };
}

/** Create a hook state with sensible defaults. */
export function createHookState(overrides: Partial<HookState> = {}): HookState {
  return {
    hookId: nextId('hook'),
    hookName: 'pre-commit-lint',
    hookEvent: 'PreToolUse',
    status: 'running',
    stdout: '',
    stderr: '',
    ...overrides,
  };
}
