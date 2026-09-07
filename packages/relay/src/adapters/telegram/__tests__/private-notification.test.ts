import { describe, expect, it, vi } from 'vitest';
import type { ApiClientOptions } from 'grammy';
import { sendPrivateTelegramNotification } from '../private-notification.js';

const input = {
  token: '123456:synthetic-telegram-token',
  chatId: '-100123',
  text: 'private notification',
  authorizeDispatch: () => true,
};
/** Supply only the network response through the installed Api; no fake SDK or transformer. */
function network(body: unknown) {
  return vi.fn<NonNullable<ApiClientOptions['fetch']>>(
    async () =>
      ({ json: async () => body }) as Awaited<ReturnType<NonNullable<ApiClientOptions['fetch']>>>
  );
}
describe('private Telegram notification using the installed Api', () => {
  it('refuses revoked authority in the final transformer before native transport', async () => {
    const fetch = network({ ok: true, result: { chat: { id: -100123 }, message_id: 7 } });
    let active = true;
    await Promise.resolve().then(() => {
      active = false;
    });
    expect(
      await sendPrivateTelegramNotification({ ...input, fetch, authorizeDispatch: () => active })
    ).toEqual({ state: 'refused' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('sends one plain JSON message and validates the exact returned chat and message', async () => {
    const fetch = network({ ok: true, result: { chat: { id: -100123 }, message_id: 7 } });
    expect(await sendPrivateTelegramNotification({ ...input, fetch })).toEqual({
      state: 'delivered',
      receiptId: 'telegram:-100123:7',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetch.mock.calls[0][1]?.body))).toEqual({
      chat_id: '-100123',
      text: 'private notification',
      link_preview_options: { is_disabled: true },
    });
    expect(
      await sendPrivateTelegramNotification({
        ...input,
        fetch: network({ ok: true, result: { chat: { id: 123 }, message_id: 7 } }),
      })
    ).toEqual({ state: 'outcome_unknown' });
  });
  it('does not install automatic retry after transport uncertainty or rate limiting', async () => {
    const fetch = network({
      ok: false,
      error_code: 429,
      description: 'Too many requests',
      parameters: { retry_after: 1 },
    });
    expect(await sendPrivateTelegramNotification({ ...input, fetch })).toEqual({
      state: 'outcome_unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockRejectedValue(new Error('synthetic network uncertainty'));
    expect(await sendPrivateTelegramNotification({ ...input, fetch })).toEqual({
      state: 'outcome_unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
