/**
 * Sessions as palette rows — attribution, titles, and what may be searched.
 */
import { describe, it, expect } from 'vitest';
import type { AgentPathEntry } from '@dorkos/shared/mesh-schemas';
import type { Session } from '@dorkos/shared/types';
import { UNTITLED_SESSION_LABEL } from '@/layers/entities/session';
import { paletteSessionKeywords, toPaletteSessionItems } from '../palette-sessions';

const agent: AgentPathEntry = {
  id: 'agent-dorkos',
  name: 'DorkOS',
  projectPath: '/projects/dorkos',
};

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    title: 'Dashboard overhaul',
    createdAt: '2026-08-09T09:00:00.000Z',
    updatedAt: '2026-08-09T10:00:00.000Z',
    permissionMode: 'default',
    runtime: 'claude-code',
    cwd: '/projects/dorkos',
    ...overrides,
  };
}

describe('toPaletteSessionItems', () => {
  it('names the agent that owns the conversation, so the row can say `Agent › title`', () => {
    const [item] = toPaletteSessionItems([makeSession()], [agent]);
    expect(item.who).toBe('DorkOS');
    expect(item.title).toBe('Dashboard overhaul');
    expect(item.agent).toBe(agent);
  });

  it('falls back to the directory name when no registered agent claims the path', () => {
    // A real state: a conversation can outlive the agent registration that made
    // it, and a row with no name at all cannot be told from its neighbours.
    const [item] = toPaletteSessionItems([makeSession({ cwd: '/work/side-quest' })], [agent]);
    expect(item.who).toBe('side-quest');
    expect(item.agent).toBeNull();
  });

  it('drops the attribution entirely when the conversation has no directory', () => {
    // No `›` means "this is the place, not a thread of it" (BC-23) — better
    // than inventing an owner.
    const [item] = toPaletteSessionItems([makeSession({ cwd: undefined })], [agent]);
    expect(item.who).toBeNull();
    expect(item.cwd).toBeNull();
  });

  it('never renders a blank title', () => {
    const [item] = toPaletteSessionItems([makeSession({ title: '' })], [agent]);
    expect(item.title).toBe(UNTITLED_SESSION_LABEL);
  });

  it('carries the origin through, so the row can draw its mark', () => {
    const [item] = toPaletteSessionItems(
      [makeSession({ origin: 'task', originLabel: 'Scheduled task · daily-digest' })],
      [agent]
    );
    expect(item.origin).toBe('task');
    expect(item.originLabel).toBe('Scheduled task · daily-digest');
  });
});

describe('paletteSessionKeywords', () => {
  it('makes the agent name and the directory typeable', () => {
    const [item] = toPaletteSessionItems([makeSession()], [agent]);
    expect(paletteSessionKeywords(item)).toEqual([item.id, 'DorkOS', '/projects/dorkos']);
  });

  it('leaves the message preview out — ⌘K finds things, not words', () => {
    const preview = 'the flaky retry loop is what breaks it';
    const [item] = toPaletteSessionItems([makeSession({ lastMessagePreview: preview })], [agent]);

    // Guard against the one-line regression: the preview is on the session, it
    // is the obvious thing to add, and adding it would turn ⌘K into a content
    // search with no way to switch it off (§15).
    const searchable = [item.title, ...paletteSessionKeywords(item)].join(' ');
    expect(searchable).not.toContain('flaky');
    expect(searchable).not.toContain(preview);
  });
});
