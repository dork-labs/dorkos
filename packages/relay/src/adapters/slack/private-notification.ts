/** Single private Slack send; no SDK retries, streaming, chunking, or payload logging. */
import { WebClient, LogLevel, type WebClientOptions } from '@slack/web-api';
import type { PrivateNotificationResult } from '../../types.js';

/** Send one bounded plain-text notification with authority checked at the actual SDK fetch. */
export async function sendPrivateSlackNotification(input: {
  token: string;
  channelId: string;
  text: string;
  authorizeDispatch(): boolean;
  fetch?: WebClientOptions['fetch'];
}): Promise<PrivateNotificationResult> {
  let attempted = false;
  if (!input.text || input.text.length > 4_000 || !/^[CDG][A-Z0-9]+$/.test(input.channelId))
    return { state: 'refused' };
  const fetch = input.fetch ?? globalThis.fetch;
  const client = new WebClient(input.token, {
    retryConfig: { retries: 0 },
    rejectRateLimitedCalls: true,
    timeout: 15_000,
    logger: {
      debug() {},
      info() {},
      warn() {},
      error() {},
      setLevel() {},
      setName() {},
      getLevel: () => LogLevel.ERROR,
    },
    fetch: (url, init) => {
      // SDK8.1.1 schedules through its request queue before this hook. No second network
      // invocation is permitted even if a later SDK version grows another retry.
      if (attempted || !input.authorizeDispatch()) throw new Error('Private notification refused.');
      attempted = true;
      return fetch(url, init);
    },
  });
  try {
    const result = await client.chat.postMessage({
      channel: input.channelId,
      text: input.text,
      mrkdwn: false,
      unfurl_links: false,
      unfurl_media: false,
    });
    if (
      result.ok !== true ||
      result.channel !== input.channelId ||
      typeof result.ts !== 'string' ||
      !/^\d+\.\d+$/.test(result.ts)
    )
      return { state: 'outcome_unknown' };
    return { state: 'delivered', receiptId: `slack:${result.channel}:${result.ts}` };
  } catch {
    return { state: attempted ? 'outcome_unknown' : 'refused' };
  }
}
