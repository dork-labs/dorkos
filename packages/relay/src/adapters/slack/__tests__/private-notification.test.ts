import { describe, expect, it, vi } from 'vitest';
import type { WebClientOptions } from '@slack/web-api';
import { sendPrivateSlackNotification } from '../private-notification.js';

const input = {
  token: 'synthetic-slack-token',
  channelId: 'C123',
  text: 'private notification',
  authorizeDispatch: () => true,
};
describe('private Slack notification using the installed WebClient', () => {
  it('refuses a source revoked during preparation at the actual SDK fetch', async () => {
    let active = true;
    const fetch = vi.fn<NonNullable<WebClientOptions['fetch']>>(
      async () => new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '123.456' }))
    );
    await Promise.resolve().then(() => {
      active = false;
    });
    expect(
      await sendPrivateSlackNotification({ ...input, fetch, authorizeDispatch: () => active })
    ).toEqual({ state: 'refused' });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('records only the exact channel and timestamp returned by Slack', async () => {
    const fetch = vi.fn<NonNullable<WebClientOptions['fetch']>>(
      async () => new Response(JSON.stringify({ ok: true, channel: 'C123', ts: '123.456' }))
    );
    expect(await sendPrivateSlackNotification({ ...input, fetch })).toEqual({
      state: 'delivered',
      receiptId: 'slack:C123:123.456',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = String(fetch.mock.calls[0][1]?.body);
    expect(body).toContain('mrkdwn=false');
    expect(body).toContain('unfurl_links=false');
    expect(
      await sendPrivateSlackNotification({
        ...input,
        fetch: async () =>
          new Response(JSON.stringify({ ok: true, channel: 'OTHER', ts: '123.456' })),
      })
    ).toEqual({ state: 'outcome_unknown' });
  });
  it('never retries a network failure or a 429 response', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('synthetic transport uncertainty');
    });
    expect(await sendPrivateSlackNotification({ ...input, fetch })).toEqual({
      state: 'outcome_unknown',
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    const limited = vi.fn<NonNullable<WebClientOptions['fetch']>>(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '1' } })
    );
    expect(await sendPrivateSlackNotification({ ...input, fetch: limited })).toEqual({
      state: 'outcome_unknown',
    });
    expect(limited).toHaveBeenCalledTimes(1);
  });
});
