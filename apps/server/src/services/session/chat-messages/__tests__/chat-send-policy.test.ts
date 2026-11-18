/** Pure policy checks: private seat routing must not expand ordinary chat authority. */
import { describe, expect, it } from 'vitest';
import type { SessionFacts } from '../../../extensions/agent-send/agent-send-defaults.js';
import { assertChatSendable, CHAT_SENDABLE_ORIGINS } from '../chat-target.js';

const facts: SessionFacts = {
  bound: true,
  launchOrigin: 'interactive',
  agentPath: '/agents/verified',
  startedByExtension: null,
  roomBound: false,
};
const deps = (overrides: Partial<SessionFacts> = {}) => ({
  describeSession: async () => ({ ...facts, ...overrides }),
});

describe('M6: ordinary chat authority stays bounded', () => {
  it('no ordinary origin is added for private seat delivery', () => {
    expect([...CHAT_SENDABLE_ORIGINS]).toEqual([
      'interactive',
      'session-relay',
      'agent-launch',
      'chat-message',
      'extension-start',
      'extension-message',
      'account-handoff',
      'account-resume',
    ]);
  });

  it('accepts a verified interactive chat through the same policy seam', async () => {
    await expect(assertChatSendable(deps(), 'interactive-chat', true)).resolves.toEqual(facts);
  });

  it.each([
    'relay-binding',
    'relay-dm',
    'connector-event',
    'schedule',
    'heartbeat',
    'harness',
    null,
  ])('refuses the ordinary target with launch origin %s', async (launchOrigin) => {
    await expect(
      assertChatSendable(deps({ launchOrigin }), 'restricted-chat', true)
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });

  it('refuses a room-bound chat even with an interactive origin', async () => {
    await expect(
      assertChatSendable(deps({ roomBound: true }), 'room-seat', true)
    ).rejects.toMatchObject({ code: 'NOT_ALLOWED' });
  });
});
