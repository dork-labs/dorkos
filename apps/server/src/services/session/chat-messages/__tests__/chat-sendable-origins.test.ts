import { describe, expect, it } from 'vitest';
import { CHAT_SENDABLE_ORIGINS, isChatSendable } from '../chat-target.js';

describe('chat sendable origins', () => {
  // M6: widening reach into bridged or unattended chats must fail review explicitly.
  it('pins the exact origins that may receive a chat message', () => {
    expect([...CHAT_SENDABLE_ORIGINS].sort()).toMatchInlineSnapshot(`
      [
        "account-handoff",
        "account-resume",
        "agent-launch",
        "chat-message",
        "extension-message",
        "extension-start",
        "interactive",
        "session-relay",
      ]
    `);
  });
});

// Binding and room standing must remain part of admission even for an otherwise allowed origin.
describe('isChatSendable', () => {
  it.each([
    [true, false, 'interactive', true],
    [false, false, 'interactive', false],
    [true, true, 'interactive', false],
    [true, false, null, false],
    ...[
      'relay-binding',
      'outside-sender',
      'connector-event',
      'schedule',
      'heartbeat',
      'unknown',
    ].map((origin) => [true, false, origin, false] as const),
  ] as const)(
    'bound=%s room=%s origin=%s admits=%s',
    (bound, roomBound, launchOrigin, expected) => {
      expect(isChatSendable({ bound, roomBound, launchOrigin })).toBe(expected);
    }
  );
});
