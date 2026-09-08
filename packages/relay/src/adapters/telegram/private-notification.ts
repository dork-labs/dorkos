/** Single private Telegram send using the native transport without autoRetry. */
import { Api, type ApiClientOptions } from 'grammy';
import type { PrivateNotificationResult } from '../../types.js';

/** Send plain JSON once; the final transformer synchronously enters the SDK's network call. */
export async function sendPrivateTelegramNotification(input: {
  token: string;
  chatId: string;
  text: string;
  authorizeDispatch(): boolean;
  fetch?: ApiClientOptions['fetch'];
}): Promise<PrivateNotificationResult> {
  if (!input.text || input.text.length > 4_000 || !/^-?\d+$/.test(input.chatId))
    return { state: 'refused' };
  let attempted = false;
  // grammY1.46.0 core/client.js20-49 calls node-fetch synchronously for this
  // plain-JSON path. No files, webhook reply or autoRetry transformer is installed.
  // SDK upgrades must retain this last-check/no-await invariant or move the guard.
  const api = new Api(input.token, {
    timeoutSeconds: 15,
    sensitiveLogs: false,
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  api.config.use((previous, method, payload, signal) => {
    if (method !== 'sendMessage' || attempted || !input.authorizeDispatch())
      throw new Error('Private notification refused.');
    attempted = true;
    return previous(method, payload, signal);
  });
  try {
    const result = await api.sendMessage(input.chatId, input.text, {
      link_preview_options: { is_disabled: true },
    });
    if (
      String(result.chat?.id) !== input.chatId ||
      !Number.isSafeInteger(result.message_id) ||
      result.message_id < 1
    )
      return { state: 'outcome_unknown' };
    return { state: 'delivered', receiptId: `telegram:${result.chat.id}:${result.message_id}` };
  } catch {
    return { state: attempted ? 'outcome_unknown' : 'refused' };
  }
}
