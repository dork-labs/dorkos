import { describe, it, expect, vi } from 'vitest';
import {
  agentActivityDisplay,
  humanizeAgentEvent,
  isNeverActive,
  type AgentActivityInput,
} from '../lib/agent-activity-display';

// Deterministic relative time. Mock the source module so the shared barrel
// re-export picks it up without disrupting other utils.
vi.mock('@/layers/shared/lib/session-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/lib/session-utils')>();
  return { ...actual, formatRelativeTime: () => '5m ago' };
});

function input(overrides: Partial<AgentActivityInput> = {}): AgentActivityInput {
  return {
    healthStatus: 'active',
    lastSeenAt: '2026-07-25T10:00:00.000Z',
    lastSeenEvent: 'heartbeat',
    sessionCount: 0,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// isNeverActive
// ---------------------------------------------------------------------------

describe('isNeverActive', () => {
  it('returns true for a stale agent that has never been seen', () => {
    expect(isNeverActive('stale', null)).toBe(true);
  });

  it('returns false for a stale agent with a last-seen timestamp', () => {
    expect(isNeverActive('stale', '2026-01-01T00:00:00.000Z')).toBe(false);
  });

  it('returns false for any other status with no timestamp', () => {
    expect(isNeverActive('active', null)).toBe(false);
    expect(isNeverActive('inactive', null)).toBe(false);
    expect(isNeverActive('unreachable', null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// humanizeAgentEvent
// ---------------------------------------------------------------------------

describe('humanizeAgentEvent', () => {
  it('phrases the events DorkOS records itself', () => {
    expect(humanizeAgentEvent('heartbeat')).toBe('Checked in');
    expect(humanizeAgentEvent('message_sent')).toBe('Got a message');
    expect(humanizeAgentEvent('response_complete')).toBe('Finished a reply');
  });

  it('matches a known event regardless of case or surrounding space', () => {
    expect(humanizeAgentEvent('  Response_Complete ')).toBe('Finished a reply');
  });

  it('never leaves an unknown event looking like an identifier', () => {
    expect(humanizeAgentEvent('tool_error')).toBe('Tool error');
    expect(humanizeAgentEvent('cron-run-finished')).toBe('Cron run finished');
  });

  it('drops punctuation from an unknown event', () => {
    expect(humanizeAgentEvent('sync::failed!')).toBe('Sync failed');
  });

  it('truncates a long event instead of stretching the row', () => {
    const phrase = humanizeAgentEvent('a'.repeat(80));
    expect(phrase.length).toBeLessThanOrEqual(32);
    expect(phrase.endsWith('…')).toBe(true);
  });

  it('falls back to a plain phrase when there are no readable words', () => {
    expect(humanizeAgentEvent('***')).toBe('Checked in');
    expect(humanizeAgentEvent('   ')).toBe('Checked in');
  });
});

// ---------------------------------------------------------------------------
// agentActivityDisplay
// ---------------------------------------------------------------------------

describe('agentActivityDisplay', () => {
  it('leads with what the agent did and follows with when', () => {
    const display = agentActivityDisplay(input({ lastSeenEvent: 'response_complete' }));
    expect(display.primary).toBe('Finished a reply');
    expect(display.secondary).toBe('5m ago');
  });

  it('adds open sessions to the second line', () => {
    expect(agentActivityDisplay(input({ sessionCount: 2 })).secondary).toBe(
      '5m ago · 2 sessions open'
    );
    expect(agentActivityDisplay(input({ sessionCount: 1 })).secondary).toBe(
      '5m ago · 1 session open'
    );
  });

  it('reads an unreachable agent as the problem it is', () => {
    const display = agentActivityDisplay(
      input({ healthStatus: 'unreachable', lastSeenEvent: 'tool_error' })
    );
    expect(display.primary).toBe('Cannot be reached');
    expect(display.secondary).toBe('Tool error · 5m ago');
    expect(display.toneClass).toBe('text-destructive');
  });

  it('says "never seen" for an unreachable agent with no history', () => {
    const display = agentActivityDisplay(
      input({ healthStatus: 'unreachable', lastSeenAt: null, lastSeenEvent: null })
    );
    expect(display.primary).toBe('Cannot be reached');
    expect(display.secondary).toBe('never seen');
  });

  it('reads a brand-new agent as unused, never as broken', () => {
    const display = agentActivityDisplay(
      input({ healthStatus: 'stale', lastSeenAt: null, lastSeenEvent: null })
    );
    expect(display.primary).toBe('Not used yet');
    expect(display.secondary).toBeNull();
    expect(display.toneClass).toBe('text-muted-foreground');
  });

  it('falls back to a plain phrase when the event is missing but the time is not', () => {
    const display = agentActivityDisplay(input({ lastSeenEvent: null }));
    expect(display.primary).toBe('Checked in');
    expect(display.secondary).toBe('5m ago');
  });

  it('dims an agent that has not been seen in the last hour', () => {
    expect(agentActivityDisplay(input({ healthStatus: 'active' })).toneClass).toBe(
      'text-foreground'
    );
    expect(agentActivityDisplay(input({ healthStatus: 'inactive' })).toneClass).toBe(
      'text-muted-foreground'
    );
    expect(
      agentActivityDisplay(input({ healthStatus: 'stale', lastSeenAt: '2026-07-01T00:00:00.000Z' }))
        .toneClass
    ).toBe('text-muted-foreground');
  });

  it('never returns an empty primary line', () => {
    for (const healthStatus of ['active', 'inactive', 'stale', 'unreachable'] as const) {
      for (const lastSeenAt of ['2026-07-25T10:00:00.000Z', null]) {
        for (const lastSeenEvent of ['heartbeat', 'weird_thing', '', null]) {
          const display = agentActivityDisplay(
            input({ healthStatus, lastSeenAt, lastSeenEvent, sessionCount: 0 })
          );
          expect(display.primary.trim().length).toBeGreaterThan(0);
        }
      }
    }
  });
});
