import { describe, it, expect } from 'vitest';
import { parseHumanSubject } from '../human-subject.js';

/**
 * Shared `relay.human.*` subject parser — extracted from BindingRouter so the
 * inbound router and the DOR-277 consent gate resolve identical routing
 * components. (These cases moved here verbatim from binding-router.test.ts.)
 */
describe('parseHumanSubject', () => {
  it('extracts adapterId from instance ID segment', () => {
    const result = parseHumanSubject('relay.human.telegram.my-bot.123456');
    expect(result.adapterId).toBe('my-bot');
    expect(result.chatId).toBe('123456');
    expect(result.channelType).toBeUndefined();
  });

  it('extracts group channel type with instance ID', () => {
    const result = parseHumanSubject('relay.human.telegram.my-bot.group.-789');
    expect(result.adapterId).toBe('my-bot');
    expect(result.chatId).toBe('-789');
    expect(result.channelType).toBe('group');
  });

  it('handles slack instance-aware subjects', () => {
    const result = parseHumanSubject('relay.human.slack.slack-1.C12345');
    expect(result.adapterId).toBe('slack-1');
    expect(result.chatId).toBe('C12345');
  });

  it('returns empty for subjects without instance ID', () => {
    const result = parseHumanSubject('relay.human.telegram');
    expect(result.adapterId).toBeUndefined();
  });

  it('handles chat IDs with dots', () => {
    const result = parseHumanSubject('relay.human.telegram.my-bot.123.456');
    expect(result.adapterId).toBe('my-bot');
    expect(result.chatId).toBe('123.456');
  });

  it('returns empty for non-relay subjects', () => {
    const result = parseHumanSubject('some.other.subject');
    expect(result).toEqual({});
  });
});
