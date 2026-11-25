import { describe, it, expect } from 'vitest';
import { buildBridgePrincipal, parseBridgePrincipal } from '../bridge-principal.js';

describe('buildBridgePrincipal / parseBridgePrincipal (DOR-871, spec §6.4)', () => {
  it.each([
    ['reply', 'tg1', 'chat-42'],
    ['initiate', 'tg1', 'chat-42'],
    ['reply', 'slack-instance-1', '42'],
    // The classification sits ahead of the tail so a dotted chat id cannot shift it.
    ['reply', 'tg1', 'chat.42.with.dots'],
    ['initiate', 'tg1', 'chat.42.with.many.dots'],
  ] as const)('round-trips %s/%s/%s', (classification, adapterId, chatId) => {
    const from = buildBridgePrincipal(classification, adapterId, chatId);
    expect(from).toBe(`relay.bridge.${classification}.${adapterId}.${chatId}`);
    expect(parseBridgePrincipal(from)).toEqual({ classification, adapterId, chatId });
  });

  it('rejects an unknown classification, a missing or empty segment, and other prefixes', () => {
    for (const from of [
      'relay.bridge.delete.tg1.chat-42',
      'relay.bridge..tg1.chat-42',
      'relay.bridge.reply',
      'relay.bridge.reply.tg1',
      'relay.bridge.reply.',
      // An empty segment would make the returned chat id a lie.
      'relay.bridge.reply.tg1..',
      'relay.bridge.reply.tg1.chat-42.',
      'relay.bridge.reply.tg1..chat-42',
      'relay.bridge.reply..chat-42',
      'relay.agent.ns.agent-1',
      'relay.human.telegram.tg1.chat-42',
      'agent:session-abc',
    ]) {
      expect(parseBridgePrincipal(from), from).toBeNull();
    }
  });

  it('refuses to build with a dotted adapterId', () => {
    expect(() => buildBridgePrincipal('reply', 'tg.1', 'chat-42')).toThrow();
  });
});
