import { describe, it, expect } from 'vitest';
import { chatSpanFields } from '../chat-span-fields.js';

const BOT = 'relay.human.telegram.tg-main.bot';

describe('chatSpanFields', () => {
  it('names a group by its title', () => {
    expect(
      chatSpanFields(BOT, {
        content: 'hi',
        senderName: 'Alice',
        channelName: 'Dev Team',
        channelType: 'group',
      })
    ).toEqual({ chatName: 'Dev Team' });
  });

  it("names a direct message by the other person's name", () => {
    expect(chatSpanFields(BOT, { content: 'hi', senderName: 'Alice', channelType: 'dm' })).toEqual({
      chatName: 'Alice',
    });
  });

  it('never names a group after whoever spoke last', () => {
    expect(
      chatSpanFields(BOT, { content: 'hi', senderName: 'Alice', channelType: 'group' })
    ).toEqual({});
  });

  it('marks a publish with no text and no media as empty', () => {
    // The Telegram "bot was added to a group" event.
    expect(
      chatSpanFields(BOT, {
        content: '',
        senderName: 'Alice',
        channelName: 'Dev Team',
        channelType: 'group',
      })
    ).toEqual({ chatName: 'Dev Team', emptyContent: true });
  });

  it('does not mark a captionless photo as empty', () => {
    expect(
      chatSpanFields(BOT, {
        content: '',
        senderName: 'Alice',
        channelType: 'dm',
        platformData: { media: { type: 'photo' } },
      })
    ).toEqual({ chatName: 'Alice' });
  });

  it('bounds a stranger-controlled name', () => {
    const fields = chatSpanFields(BOT, { content: 'x', senderName: 'A'.repeat(500) });
    expect(fields.chatName).toHaveLength(200);
  });

  it('cuts a long name by code point, never splitting an emoji', () => {
    // 199 letters then emoji: a UTF-16 slice at 200 would keep half the pair.
    const name = 'A'.repeat(199) + '😀😀';
    const fields = chatSpanFields(BOT, { content: 'x', senderName: name });
    expect(fields.chatName).toBe('A'.repeat(199) + '😀');
    expect(Array.from(fields.chatName!)).toHaveLength(200);
    expect(fields.chatName).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('records nothing for a publish that did not come from a chat connection', () => {
    expect(
      chatSpanFields('agent:session-1', { content: '', senderName: 'Agent', channelType: 'dm' })
    ).toEqual({});
  });

  it('records nothing and never reads the body of a non-object payload', () => {
    expect(chatSpanFields(BOT, 'plain text')).toEqual({});
    expect(chatSpanFields(BOT, null)).toEqual({});
  });
});
