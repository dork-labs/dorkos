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
    chatState: 'inactive',
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

  it('keeps the acronyms DorkOS names things with', () => {
    expect(humanizeAgentEvent('MCP_tool_call')).toBe('MCP tool call');
    expect(humanizeAgentEvent('A2A_message')).toBe('A2A message');
    expect(humanizeAgentEvent('relay_NATS_publish')).toBe('Relay NATS publish');
    // A leading acronym keeps its own case rather than being re-capitalised.
    expect(humanizeAgentEvent('SDK_ready')).toBe('SDK ready');
  });

  it('sentence-cases a long all-caps run instead of shouting it', () => {
    expect(humanizeAgentEvent('HEARTBEAT_FAILED')).toBe('Heartbeat failed');
  });

  it('drops punctuation from an unknown event', () => {
    expect(humanizeAgentEvent('sync::failed!')).toBe('Sync failed');
  });

  it('truncates a long event instead of stretching the row', () => {
    const phrase = humanizeAgentEvent('a'.repeat(80));
    expect(Array.from(phrase).length).toBeLessThanOrEqual(32);
    expect(phrase.endsWith('…')).toBe(true);
  });

  it('never splits a long value into a lone surrogate', () => {
    // 𝐁𝐂𝐃 are astral letters, so they survive the word filter and the cut
    // lands mid-pair if truncation counts UTF-16 units instead of code points.
    const phrase = humanizeAgentEvent(`${'a'.repeat(30)}𝐁𝐂𝐃`);
    const unpairedSurrogate =
      /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
    expect(phrase).not.toMatch(unpairedSurrogate);
    // A lone surrogate would come back from a UTF-8 round-trip as U+FFFD.
    expect(phrase).toBe(Buffer.from(phrase, 'utf8').toString('utf8'));
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

  it('never claims a chat is open, at any chat state', () => {
    // The only count this page can reach is a lifetime transcript count for one
    // selected folder, so "N sessions open" was never something it could know.
    for (const chatState of ['needs-attention', 'active', 'idle', 'fresh', 'inactive'] as const) {
      const { primary, secondary } = agentActivityDisplay(input({ chatState }));
      expect(`${primary} ${secondary ?? ''}`).not.toMatch(/session/i);
    }
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

  it('says a blocked chat needs you, and demotes the event', () => {
    const display = agentActivityDisplay(
      input({ healthStatus: 'inactive', chatState: 'needs-attention' })
    );
    expect(display.primary).toBe('A chat needs you');
    expect(display.secondary).toBe('Checked in · 5m ago');
    expect(display.toneClass).toBe('text-destructive');
  });

  it('lets an unreachable folder outrank a blocked chat', () => {
    const display = agentActivityDisplay(
      input({ healthStatus: 'unreachable', chatState: 'needs-attention' })
    );
    expect(display.primary).toBe('Cannot be reached');
  });

  it('reads a brand-new agent as unused, never as broken', () => {
    const display = agentActivityDisplay(
      input({ healthStatus: 'stale', lastSeenAt: null, lastSeenEvent: null })
    );
    expect(display.primary).toBe('Not used yet');
    expect(display.secondary).toBeNull();
    expect(display.toneClass).toBe('text-muted-foreground');
  });

  it('does not call an agent unused while chats are running under its folder', () => {
    // An agent only reports to the mesh when DorkOS dispatches the turn, so a
    // session started with the bare `claude` CLI leaves a live agent with no
    // last-seen. "Not used yet" on a row sitting in Working would be false.
    const display = agentActivityDisplay(
      input({ healthStatus: 'stale', lastSeenAt: null, lastSeenEvent: null, chatState: 'active' })
    );
    expect(display.primary).toBe('Active in a chat');
    expect(display.toneClass).toBe('text-foreground');
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

  it('never invents a time it does not have', () => {
    const display = agentActivityDisplay(input({ healthStatus: 'active', lastSeenAt: null }));
    expect(display.secondary).toBeNull();
  });

  it('never returns an empty primary line', () => {
    for (const healthStatus of ['active', 'inactive', 'stale', 'unreachable'] as const) {
      for (const lastSeenAt of ['2026-07-25T10:00:00.000Z', null]) {
        for (const lastSeenEvent of ['heartbeat', 'weird_thing', '', null]) {
          for (const chatState of ['needs-attention', 'active', 'fresh', 'inactive'] as const) {
            const display = agentActivityDisplay(
              input({ healthStatus, lastSeenAt, lastSeenEvent, chatState })
            );
            expect(display.primary.trim().length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
