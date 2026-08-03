import { describe, it, expect } from 'vitest';
import {
  BRIDGE_PRINCIPAL_PREFIX,
  buildBridgePrincipal,
  parseBridgePrincipal,
} from '../bridge-principal.js';

describe('buildBridgePrincipal / parseBridgePrincipal (DOR-871, spec §6.4)', () => {
  it('round-trips reply and initiate principals', () => {
    expect(buildBridgePrincipal('reply', 'tg1', 'chat-42')).toBe('relay.bridge.reply.tg1.chat-42');
    expect(buildBridgePrincipal('initiate', 'tg1', 'chat-42')).toBe(
      'relay.bridge.initiate.tg1.chat-42'
    );
    expect(parseBridgePrincipal(buildBridgePrincipal('reply', 'tg1', 'chat-42'))).toEqual({
      classification: 'reply',
      adapterId: 'tg1',
      chatId: 'chat-42',
    });
    expect(parseBridgePrincipal(buildBridgePrincipal('initiate', 'tg1', 'chat-42'))).toEqual({
      classification: 'initiate',
      adapterId: 'tg1',
      chatId: 'chat-42',
    });
  });

  it('parses a dot-containing chat id positionally, for both classifications', () => {
    // The whole reason the classification sits ahead of the tail: a chat id
    // with dots must not shift what the parser reads as the classification.
    const dotty = 'chat.42.with.dots';
    expect(parseBridgePrincipal(buildBridgePrincipal('reply', 'tg1', dotty))).toEqual({
      classification: 'reply',
      adapterId: 'tg1',
      chatId: dotty,
    });
    expect(parseBridgePrincipal(buildBridgePrincipal('initiate', 'tg1', dotty))).toEqual({
      classification: 'initiate',
      adapterId: 'tg1',
      chatId: dotty,
    });
    // Same assertion spelled out literally, so a future refactor of the
    // builder can't silently break the positional contract without a
    // string-level test catching it.
    expect(parseBridgePrincipal('relay.bridge.reply.tg1.chat.42.with.dots')).toEqual({
      classification: 'reply',
      adapterId: 'tg1',
      chatId: 'chat.42.with.dots',
    });
  });

  it('denies an unrecognized classification segment rather than defaulting to either', () => {
    expect(parseBridgePrincipal('relay.bridge.delete.tg1.chat-42')).toBeNull();
    expect(parseBridgePrincipal('relay.bridge..tg1.chat-42')).toBeNull();
  });

  it('rejects a missing adapterId or chatId', () => {
    expect(parseBridgePrincipal('relay.bridge.reply')).toBeNull();
    expect(parseBridgePrincipal('relay.bridge.reply.tg1')).toBeNull();
    expect(parseBridgePrincipal('relay.bridge.reply.')).toBeNull();
  });

  it('rejects an empty segment anywhere in adapterId/chatId (m3)', () => {
    // A `..` collapse or a trailing `.` produces an empty segment. Letting
    // one through would make the returned chatId a lie about what was
    // actually in the string (e.g. joining ['', ''] silently yields ".").
    expect(parseBridgePrincipal('relay.bridge.reply.tg1..')).toBeNull();
    expect(parseBridgePrincipal('relay.bridge.reply.tg1.chat-42.')).toBeNull();
    expect(parseBridgePrincipal('relay.bridge.reply.tg1..chat-42')).toBeNull();
    expect(parseBridgePrincipal('relay.bridge.reply..chat-42')).toBeNull();
  });

  it('rejects anything not under the bridge prefix', () => {
    expect(parseBridgePrincipal('relay.agent.ns.agent-1')).toBeNull();
    expect(parseBridgePrincipal('relay.human.telegram.tg1.chat-42')).toBeNull();
    expect(parseBridgePrincipal('agent:session-abc')).toBeNull();
  });

  it('BRIDGE_PRINCIPAL_PREFIX matches what the builder emits', () => {
    expect(buildBridgePrincipal('reply', 'a', 'b').startsWith(BRIDGE_PRINCIPAL_PREFIX)).toBe(true);
  });

  it('build -> parse is the identity for adapterId/chatId/classification (m2 round-trip)', () => {
    const cases: Array<['reply' | 'initiate', string, string]> = [
      ['reply', 'tg1', 'chat-42'],
      ['initiate', 'tg1', 'chat-42'],
      ['reply', 'slack-instance-1', '42'],
      ['initiate', 'tg1', 'chat.42.with.many.dots'],
      ['reply', 'a', '0'],
    ];
    for (const [classification, adapterId, chatId] of cases) {
      const from = buildBridgePrincipal(classification, adapterId, chatId);
      expect(parseBridgePrincipal(from)).toEqual({ classification, adapterId, chatId });
    }
  });

  it('buildBridgePrincipal rejects a dotted adapterId (m2)', () => {
    // A dot in adapterId would shift where the parser thinks the chat id
    // starts — this must be caught at construction, not silently misread.
    expect(() => buildBridgePrincipal('reply', 'tg.1', 'chat-42')).toThrow();
    expect(() => buildBridgePrincipal('initiate', 'a.b.c', 'chat-42')).toThrow();
  });
});
