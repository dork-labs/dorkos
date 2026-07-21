import { describe, it, expect } from 'vitest';
import { classifyOrigin } from '../classify-origin.js';

/** Build a `<relay_context>` block matching `formatPromptWithContext`'s exact shape. */
function relayContext(
  from: string,
  content = 'hello',
  identity?: { sender?: string; chat?: string }
): string {
  // This fixture mirrors the line format produced by `formatPromptWithContext`
  // in packages/relay/src/adapters/claude-code/agent-handler.ts:423-453
  // (Agent-ID, Session-ID, From, optional Sender/Chat, Message-ID, Subject,
  // Sent, blank line, budget lines). Only the From:/Sender:/Chat: lines matter
  // to classifyOrigin, but the full shape is reproduced here so a real format
  // drift (e.g. reordered lines, renamed fields) breaks this test rather than
  // silently going unnoticed — if this fixture and the real function ever
  // diverge, update both in lockstep.
  const lines = [
    'Agent-ID: agent-123',
    'Session-ID: sess-abc',
    `From: ${from}`,
    ...(identity?.sender !== undefined ? [`Sender: ${identity.sender}`] : []),
    ...(identity?.chat !== undefined ? [`Chat: ${identity.chat}`] : []),
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

  it('returns {} (user) for suffixed relay.human.console principals', () => {
    expect(classifyOrigin(relayContext('relay.human.console.inferred'))).toEqual({});
    expect(classifyOrigin(relayContext('relay.human.console.user'))).toEqual({});
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

  it('enriches a Telegram origin label with the sender name', () => {
    expect(
      classifyOrigin(relayContext('relay.human.telegram.bot', 'hi', { sender: 'Dorian' }))
    ).toEqual({ origin: 'channel', originLabel: 'Telegram · Dorian' });
  });

  it('enriches a Slack origin label — chat title wins over sender when both present', () => {
    expect(
      classifyOrigin(relayContext('slack:C0123', 'hi', { sender: 'Dorian', chat: '#incidents' }))
    ).toEqual({ origin: 'channel', originLabel: 'Slack · #incidents' });
  });

  it('falls back to the sender name when chat is absent', () => {
    expect(classifyOrigin(relayContext('slack:C0123', 'hi', { sender: 'Priya' }))).toEqual({
      origin: 'channel',
      originLabel: 'Slack · Priya',
    });
  });

  it('keeps the legacy plain label when no identity lines are present', () => {
    expect(classifyOrigin(relayContext('relay.human.telegram.bot'))).toEqual({
      origin: 'channel',
      originLabel: 'Telegram',
    });
  });

  it('caps the composed channel label at 60 characters', () => {
    const longChat = `#${'x'.repeat(80)}`;
    const result = classifyOrigin(relayContext('slack:C0123', 'hi', { chat: longChat }));
    expect(result.originLabel).toHaveLength(60);
    expect(result.originLabel).toBe(`Slack · ${longChat}`.slice(0, 60));
  });

  it('ignores Sender:/Chat: lines on the agent branch', () => {
    expect(
      classifyOrigin(
        relayContext('relay.agent.01H8ABCDEFGHIJKLMNOPQRSTUV', 'hi', {
          sender: 'Dorian',
          chat: '#ops',
        })
      )
    ).toEqual({ origin: 'agent', originLabel: '01H8ABCDEFGHIJKLMNOPQRST (agent)' });
  });

  it('ignores Sender:/Chat: lines on the task branch', () => {
    expect(
      classifyOrigin(relayContext('relay.system.tasks.scheduler', 'hi', { sender: 'Dorian' }))
    ).toEqual({ origin: 'task', originLabel: 'Scheduled task' });
  });

  it('ignores Sender:/Chat: lines on the external branch', () => {
    expect(classifyOrigin(relayContext('a2a-gateway', 'hi', { sender: 'Dorian' }))).toEqual({
      origin: 'external',
      originLabel: 'A2A client',
    });
  });

  it('ignores Sender:/Chat: lines for the operator (relay.human.console)', () => {
    expect(classifyOrigin(relayContext('relay.human.console', 'hi', { sender: 'Dorian' }))).toEqual(
      {}
    );
  });
});
