/**
 * Telegram webhook management.
 *
 * Handles webhook URL registration with the Telegram Bot API,
 * secret token generation and verification, and the HTTP server
 * lifecycle for receiving webhook callbacks.
 *
 * @module relay/adapters/telegram-webhook
 */
import crypto from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { webhookCallback, type Bot } from 'grammy';

/** Default webhook port when not specified in config. */
const DEFAULT_WEBHOOK_PORT = 8443;

/**
 * Start the webhook HTTP server and register the webhook URL with Telegram.
 *
 * Registers the webhook URL with Telegram (including a secret token for
 * request validation), creates an HTTP server using grammy's
 * `webhookCallback`, and starts listening on the configured port.
 *
 * @param bot - The grammy Bot instance
 * @param adapterId - The adapter instance ID for error messages
 * @param webhookUrl - The public HTTPS URL where Telegram sends updates
 * @param webhookPort - The port for the webhook HTTP server (defaults to 8443)
 * @param webhookSecret - Optional pre-shared secret; auto-generated if omitted
 * @returns The created HTTP server instance
 */
export async function startWebhookMode(
  bot: Bot,
  adapterId: string,
  webhookUrl: string | undefined,
  webhookPort: number | undefined,
  webhookSecret: string | undefined
): Promise<Server> {
  if (!webhookUrl) {
    throw new Error(`TelegramAdapter(${adapterId}): webhookUrl is required when mode is 'webhook'`);
  }

  // Auto-generate secret if not provided in config
  const secret = webhookSecret ?? crypto.randomUUID();

  await bot.api.setWebhook(webhookUrl, { secret_token: secret });

  const port = webhookPort ?? DEFAULT_WEBHOOK_PORT;
  const handler = webhookCallback(bot, 'http', { secretToken: secret });
  const server = createServer(handler);

  // Harden the HTTP server with timeout and size limits
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 50;
  server.keepAliveTimeout = 5_000;

  await new Promise<void>((resolve, reject) => {
    server.listen(port, resolve);
    // Use once() so the error handler is automatically removed after the
    // promise settles — prevents a stale reject reference from leaking as
    // a persistent listener on later server errors.
    server.once('error', reject);
  });

  return server;
}

/**
 * Shut down the webhook HTTP server if one is running.
 *
 * Calls `closeAllConnections()` before `close()` to forcibly terminate any
 * keep-alive connections that would otherwise prevent the server from
 * closing promptly.
 *
 * @param server - The HTTP server to stop, or null if no server is running
 */
export async function stopWebhookServer(server: Server | null): Promise<void> {
  if (!server) return;
  // Forcibly close keep-alive connections so server.close() resolves
  // immediately rather than waiting for clients to disconnect on their own.
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}
