import { describe, it, expect, vi } from 'vitest';
import type { Bot } from 'grammy';
import { sendMessageDraft } from '../stream-api.js';

describe('sendMessageDraft', () => {
  it('calls bot.api.sendMessageDraft with correct params', async () => {
    const mockSendMessageDraft = vi.fn().mockResolvedValue(undefined);
    const bot = {
      api: { sendMessageDraft: mockSendMessageDraft },
    } as unknown as Bot;

    await sendMessageDraft(bot, 12345, 'Hello draft');

    expect(mockSendMessageDraft).toHaveBeenCalledOnce();
    expect(mockSendMessageDraft).toHaveBeenCalledWith(12345, 'Hello draft');
  });

  it('propagates errors from the underlying API call', async () => {
    const bot = {
      api: { sendMessageDraft: vi.fn().mockRejectedValue(new Error('draft unavailable')) },
    } as unknown as Bot;

    await expect(sendMessageDraft(bot, 99, 'text')).rejects.toThrow('draft unavailable');
  });
});
