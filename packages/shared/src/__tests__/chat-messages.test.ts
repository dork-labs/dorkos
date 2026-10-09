import { describe, expect, it } from 'vitest';
import { isMessagingToolName, messagingToolOf } from '../chat-messages.js';

describe('messagingToolOf', () => {
  it('reads the bare name and every DorkOS server prefix', () => {
    for (const name of ['chat_send', 'chat_stop', 'session_start']) {
      expect(messagingToolOf(name)).toBe(name);
      expect(messagingToolOf(`mcp__dorkos__${name}`)).toBe(name);
      expect(messagingToolOf(`dorkos_${name}`)).toBe(name);
      expect(messagingToolOf(`dorkos.${name}`)).toBe(name);
    }
  });

  it("never matches another server's tool of the same name", () => {
    expect(messagingToolOf('mcp__other__chat_send')).toBeNull();
    expect(messagingToolOf('other.chat_send')).toBeNull();
    expect(messagingToolOf('notdorkos_chat_send')).toBeNull();
    expect(messagingToolOf('mcp__other__dorkos_chat_send')).toBeNull();
    expect(isMessagingToolName('mcp__github__session_start')).toBe(false);
  });

  it('leaves chat_read and other tools alone', () => {
    expect(messagingToolOf('mcp__dorkos__chat_read')).toBeNull();
    expect(isMessagingToolName('Read')).toBe(false);
  });
});
