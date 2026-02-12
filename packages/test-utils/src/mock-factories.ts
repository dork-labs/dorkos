import type { Session, StreamEvent, CommandEntry } from '@lifeos/shared/types';

export function createMockSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'test-session-1',
    title: 'Test Session',
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
    permissionMode: 'default',
    ...overrides,
  };
}

export function createMockStreamEvent(
  type: StreamEvent['type'],
  data: StreamEvent['data']
): StreamEvent {
  return { type, data };
}

export function createMockCommandEntry(overrides: Partial<CommandEntry> = {}): CommandEntry {
  return {
    namespace: 'test',
    command: 'example',
    fullCommand: '/test:example',
    description: 'A test command',
    filePath: '.claude/commands/test/example.md',
    ...overrides,
  };
}
