import { describe, it, expect } from 'vitest';
import { classifyOrigin } from '../classify-origin.js';

/** Build a `<relay_context>` block matching `formatPromptWithContext`'s exact shape. */
function relayContext(from: string, content = 'hello'): string {
  // This fixture mirrors the line format produced by `formatPromptWithContext`
  // in packages/relay/src/adapters/claude-code/agent-handler.ts:417-444
  // (Agent-ID, Session-ID, From, Message-ID, Subject, Sent, blank line, budget
  // lines). Only the `From:` line matters to classifyOrigin, but the full
  // shape is reproduced here so a real format drift (e.g. reordered lines,
  // renamed fields) breaks this test rather than silently going unnoticed —
  // if this fixture and the real function ever diverge, update both in
  // lockstep.
  const lines = [
    'Agent-ID: agent-123',
    'Session-ID: sess-abc',
    `From: ${from}`,
    'Message-ID: msg-1',
    'Subject: test subject',
    'Sent: 2026-07-21T00:00:00.000Z',
    '',
    'Budget remaining:',
    '- Hops: 0 of 5 used',
    '- TTL: 300 seconds remaining',
    '- Max turns: 10',
  ];
  return `<relay_context>\n${lines.join('\n')}\n</relay_context>\n\n${content}`;
}

describe('classifyOrigin', () => {
  it('returns {} for a plain message with no marker', () => {
    expect(classifyOrigin('Hello, can you help me with this?')).toEqual({});
  });

  it('returns { origin: task } for a literal TASK SCHEDULER CONTEXT marker', () => {
    expect(classifyOrigin('=== TASK SCHEDULER CONTEXT ===\nRun the daily digest')).toEqual({
      origin: 'task',
    });
  });

  it('returns { origin: external, originLabel: Relay } for a relay_context block with no From line', () => {
    const block = '<relay_context>\nAgent-ID: abc\n</relay_context>\n\nhello';
    expect(classifyOrigin(block)).toEqual({ origin: 'external', originLabel: 'Relay' });
  });

  it('returns {} (user) for From: relay.human.console', () => {
    expect(classifyOrigin(relayContext('relay.human.console'))).toEqual({});
  });

  it.each([
    ['a2a-gateway', { origin: 'external', originLabel: 'A2A client' }],
    ['relay.external.mcp', { origin: 'external', originLabel: 'External MCP client' }],
    ['relay.system.tasks.scheduler', { origin: 'task', originLabel: 'Scheduled task' }],
    ['relay.system.tasks.reminders', { origin: 'task', originLabel: 'Scheduled task' }],
    ['telegram:12345', { origin: 'channel', originLabel: 'Telegram' }],
    ['relay.human.telegram.bot', { origin: 'channel', originLabel: 'Telegram' }],
    ['TELEGRAM-BOT-9', { origin: 'channel', originLabel: 'Telegram' }],
    ['slack:C0123', { origin: 'channel', originLabel: 'Slack' }],
    ['Slack-App', { origin: 'channel', originLabel: 'Slack' }],
    ['relay.webhook.generic', { origin: 'channel', originLabel: 'Webhook' }],
    ['relay.human.discord', { origin: 'channel', originLabel: 'Channel' }],
    [
      'relay.agent.01H8ABCDEFGHIJKLMNOPQRSTUV',
      { origin: 'agent', originLabel: '01H8ABCDEFGHIJKLMNOPQRST (agent)' },
    ],
    ['relay.session.short', { origin: 'agent', originLabel: 'short (agent)' }],
    ['something-unrecognized', { origin: 'external', originLabel: 'Relay' }],
  ])('classifies From: %s', (from, expected) => {
    expect(classifyOrigin(relayContext(from))).toEqual(expected);
  });
});
