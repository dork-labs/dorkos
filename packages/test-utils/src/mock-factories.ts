import type { Session, StreamEvent, CommandEntry } from '@dorkos/shared/types';
import type { RoadmapItem, RoadmapMeta } from '@dorkos/shared/roadmap-schemas';

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

/** Create a mock RoadmapItem with sensible defaults. */
export function createMockRoadmapItem(overrides: Partial<RoadmapItem> = {}): RoadmapItem {
  return {
    id: '00000000-0000-4000-a000-000000000001',
    title: 'Test roadmap item',
    type: 'feature',
    moscow: 'must-have',
    status: 'not-started',
    health: 'on-track',
    timeHorizon: 'now',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/** Create a mock RoadmapMeta with health stats. */
export function createMockRoadmapMeta(overrides: Partial<RoadmapMeta> = {}): RoadmapMeta {
  return {
    projectName: 'Test Project',
    projectSummary: 'A test roadmap project',
    lastUpdated: '2025-01-01T00:00:00.000Z',
    timeHorizons: {
      now: { label: 'Now', description: 'Current sprint' },
      next: { label: 'Next', description: 'Next sprint' },
      later: { label: 'Later', description: 'Future work' },
    },
    ...overrides,
  };
}
