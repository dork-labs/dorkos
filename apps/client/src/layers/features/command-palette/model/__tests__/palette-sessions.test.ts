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

/**
 * A day boundary every fixture below is already on the live side of.
 *
 * Named rather than inlined so the archived cases can say what they are moving
 * relative to, and so the attribution cases are not quietly asserting a second
 * thing about time.
 */
const LIVE_SINCE = Date.parse('2026-08-09T04:00:00.000Z');

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
    const [item] = toPaletteSessionItems([makeSession()], [agent], LIVE_SINCE);
    expect(item.who).toBe('DorkOS');
    expect(item.title).toBe('Dashboard overhaul');
    expect(item.agent).toBe(agent);
  });

  it('falls back to the directory name when no registered agent claims the path', () => {
    // A real state: a conversation can outlive the agent registration that made
    // it, and a row with no name at all cannot be told from its neighbours.
    const [item] = toPaletteSessionItems(
      [makeSession({ cwd: '/work/side-quest' })],
      [agent],
      LIVE_SINCE
    );
    expect(item.who).toBe('side-quest');
    expect(item.agent).toBeNull();
  });

  it('drops the attribution entirely when the conversation has no directory', () => {
    // No `›` means "this is the place, not a thread of it" (BC-23) — better
    // than inventing an owner.
    const [item] = toPaletteSessionItems([makeSession({ cwd: undefined })], [agent], LIVE_SINCE);
    expect(item.who).toBeNull();
    expect(item.cwd).toBeNull();
  });

  it('never renders a blank title', () => {
    const [item] = toPaletteSessionItems([makeSession({ title: '' })], [agent], LIVE_SINCE);
    expect(item.title).toBe(UNTITLED_SESSION_LABEL);
  });

  it('carries the origin through, so the row can draw its mark', () => {
    const [item] = toPaletteSessionItems(
      [makeSession({ origin: 'task', originLabel: 'Scheduled task · daily-digest' })],
      [agent],
      LIVE_SINCE
    );
    expect(item.origin).toBe('task');
    expect(item.originLabel).toBe('Scheduled task · daily-digest');
  });
});

describe('the archived label', () => {
  it('marks a conversation last touched before the day turned over', () => {
    const [item] = toPaletteSessionItems(
      [makeSession({ updatedAt: '2026-08-08T22:00:00.000Z' })],
      [agent],
      LIVE_SINCE
    );
    expect(item.archived).toBe(true);
  });

  it('leaves a conversation from this morning unmarked', () => {
    const [item] = toPaletteSessionItems(
      [makeSession({ updatedAt: '2026-08-09T09:00:00.000Z' })],
      [agent],
      LIVE_SINCE
    );
    expect(item.archived).toBe(false);
  });

  it('draws the line at the boundary itself, not a minute either side', () => {
    // The two cases above are hours apart, so either could pass against a rule
    // that is a day out. These are one millisecond apart.
    const [before] = toPaletteSessionItems(
      [makeSession({ updatedAt: new Date(LIVE_SINCE - 1).toISOString() })],
      [agent],
      LIVE_SINCE
    );
    const [at] = toPaletteSessionItems(
      [makeSession({ updatedAt: new Date(LIVE_SINCE).toISOString() })],
      [agent],
      LIVE_SINCE
    );
    expect([before.archived, at.archived]).toEqual([true, false]);
  });

  it('says nothing about a timestamp it cannot read', () => {
    // An unparsable date is a thing this client knows NOTHING about. Labelling
    // it archived would be asserting a fact about somebody's conversation on
    // the strength of a parse failure — and `NaN < boundary` is false, so the
    // safe answer is also the one the arithmetic gives.
    const [item] = toPaletteSessionItems(
      [makeSession({ updatedAt: 'not a date' })],
      [agent],
      LIVE_SINCE
    );
    expect(item.archived).toBe(false);
  });
});

describe('paletteSessionKeywords', () => {
  it('makes the agent name and the directory typeable', () => {
    const [item] = toPaletteSessionItems([makeSession()], [agent], LIVE_SINCE);
    expect(paletteSessionKeywords(item)).toEqual([item.id, 'DorkOS', '/projects/dorkos']);
  });

  it('leaves the message preview out — ⌘K finds things, not words', () => {
    const preview = 'the flaky retry loop is what breaks it';
    const [item] = toPaletteSessionItems(
      [makeSession({ lastMessagePreview: preview })],
      [agent],
      LIVE_SINCE
    );

    // Guard against the one-line regression: the preview is on the session, it
    // is the obvious thing to add, and adding it would turn ⌘K into a content
    // search with no way to switch it off (§15).
    const searchable = [item.title, ...paletteSessionKeywords(item)].join(' ');
    expect(searchable).not.toContain('flaky');
    expect(searchable).not.toContain(preview);
  });
});
