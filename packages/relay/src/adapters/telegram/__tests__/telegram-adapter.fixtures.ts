/**
 * Shared mocks and builders for the TelegramAdapter test files. The test files
 * route `node:http`, `grammy` and `@grammyjs/auto-retry` here with `vi.mock`.
 */
import { vi, type Mock } from 'vitest';
import type { RelayPublisher, Unsubscribe } from '../../../types.js';
import type { z } from 'zod';
import { TelegramAdapterConfigSchema } from '@dorkos/shared/relay-schemas';
import type { TelegramAdapterConfig } from '../../../types.js';

// --- node:http mock ---
// Replaces the real HTTP server to avoid port-binding in tests and to expose
// server.on / server.once / server.closeAllConnections for assertion.

export const mockServerListen: Mock = vi.fn();
export const mockServerClose: Mock = vi.fn();
export const mockServerOn: Mock = vi.fn();
export const mockServerOnce: Mock = vi.fn();
export const mockServerCloseAllConnections: Mock = vi.fn();

export class MockServer {
  headersTimeout = 0;
  requestTimeout = 0;
  maxHeadersCount = 0;
  keepAliveTimeout = 0;

  listen(_port: number, cb?: () => void) {
    mockServerListen(_port, cb);
    // Immediately invoke the callback so the listen promise resolves
    cb?.();
    return this;
  }

  close(cb?: (err?: Error) => void) {
    mockServerClose(cb);
    // Immediately invoke the callback with no error so the close promise resolves
    cb?.();
    return this;
  }

  on(event: string, handler: (...args: unknown[]) => void) {
    mockServerOn(event, handler);
    return this;
  }

  once(event: string, handler: (...args: unknown[]) => void) {
    mockServerOnce(event, handler);
    return this;
  }

  closeAllConnections() {
    mockServerCloseAllConnections();
  }
}

/** The `node:http` module the adapter sees: a server that never binds a port. */
export const httpModule = (): Record<string, unknown> => ({
  createServer: vi.fn((_handler: unknown) => {
    captured.server = new MockServer();
    return captured.server;
  }),
});

// --- grammy mock ---
// We mock the grammy module to avoid real Telegram API calls in tests.

export const mockSendMessage: Mock = vi.fn().mockResolvedValue({ message_id: 1 });
export const mockSendChatAction: Mock = vi.fn().mockResolvedValue(true);
export const mockSetWebhook: Mock = vi.fn().mockResolvedValue(true);
export const mockDeleteWebhook: Mock = vi.fn().mockResolvedValue(true);
export const mockLeaveChat: Mock = vi.fn().mockResolvedValue(true);
export const mockGetMe: Mock = vi.fn().mockResolvedValue({
  id: 777,
  is_bot: true,
  username: 'test_bot',
  can_read_all_group_messages: true,
});
export const mockBotInit: Mock = vi.fn().mockResolvedValue(undefined);
export const mockBotStart: Mock = vi.fn().mockResolvedValue(undefined);
export const mockBotStop: Mock = vi.fn().mockResolvedValue(undefined);
export const mockBotCatch: Mock = vi.fn();

type Handler = (ctx: unknown) => Promise<void>;

/**
 * What the mocked Bot and HTTP server captured: the handlers the adapter
 * registered and the last server it created. Reset by {@link resetCaptured}.
 */
export const captured = {
  message: null as Handler | null,
  callbackQuery: null as Handler | null,
  /** Registered via bot.on('my_chat_member', handler) — DOR-883. */
  chatMember: null as Handler | null,
  error: null as ((err: unknown) => void) | null,
  onStart: null as (() => void) | null,
  server: null as MockServer | null,
};

/** Clear every captured handler and server between tests. */
export function resetCaptured(): void {
  captured.message = null;
  captured.callbackQuery = null;
  captured.chatMember = null;
  captured.error = null;
  captured.onStart = null;
  captured.server = null;
}

/** The `grammy` module the adapter sees: a Bot that records what it was given. */
export const grammyModule = (): Record<string, unknown> => {
  class MockBot {
    api = {
      config: {
        use: vi.fn(),
      },
      sendMessage: mockSendMessage,
      sendChatAction: mockSendChatAction,
      setWebhook: mockSetWebhook,
      deleteWebhook: mockDeleteWebhook,
      getMe: mockGetMe,
      leaveChat: mockLeaveChat,
    };

    botInfo = { username: 'test_bot' };

    on(event: string, handler: (ctx: unknown) => Promise<void>) {
      if (event === 'callback_query:data') {
        captured.callbackQuery = handler;
      } else if (event === 'my_chat_member') {
        captured.chatMember = handler;
      } else if (event === 'message') {
        captured.message = handler;
      }
    }

    catch(handler: (err: unknown) => void) {
      captured.error = handler;
      mockBotCatch(handler);
    }

    async init() {
      return mockBotInit();
    }

    async start(opts?: { drop_pending_updates?: boolean; onStart?: () => void }) {
      captured.onStart = opts?.onStart ?? null;
      // Simulate onStart being called immediately for polling mode
      if (opts?.onStart) opts.onStart();
      return mockBotStart(opts);
    }

    async stop() {
      return mockBotStop();
    }
  }

  // webhookCallback returns a simple no-op request handler for tests
  const webhookCallback = vi.fn().mockReturnValue(vi.fn().mockResolvedValue(undefined));

  return { Bot: MockBot, webhookCallback };
};

/** The auto-retry plugin, inert. */
export const autoRetryModule = (): Record<string, unknown> => ({
  autoRetry: vi.fn().mockReturnValue(vi.fn()),
});

/**
 * A Telegram adapter config with schema defaults filled in.
 *
 * Built through `TelegramAdapterConfigSchema` rather than as an object literal
 * so the fixture inherits every default the real config path applies. When the
 * schema gains a field (as it did with `streaming`), these call sites keep
 * compiling and keep matching production instead of drifting.
 */
export function tgConfig(
  overrides: z.input<typeof TelegramAdapterConfigSchema>
): TelegramAdapterConfig {
  return TelegramAdapterConfigSchema.parse(overrides);
}

// --- Relay mock helpers ---

export function createMockRelay(): RelayPublisher {
  const signalHandlers: Array<{
    pattern: string;
    handler: (subject: string, signal: { type: string; state: string }) => void;
  }> = [];

  const relay: RelayPublisher = {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    subscribe: vi.fn().mockReturnValue(() => {}),
    onSignal: vi
      .fn()
      .mockImplementation(
        (
          pattern: string,
          handler: (subject: string, signal: { type: string; state: string }) => void
        ): Unsubscribe => {
          signalHandlers.push({ pattern, handler });
          return () => {
            const idx = signalHandlers.findIndex((s) => s.handler === handler);
            if (idx >= 0) signalHandlers.splice(idx, 1);
          };
        }
      ),
  };

  // Expose a way to trigger signals from tests
  (
    relay as RelayPublisher & {
      _emitSignal: (subject: string, signal: { type: string; state: string }) => void;
    }
  )._emitSignal = (subject: string, signal: { type: string; state: string }) => {
    for (const { handler } of signalHandlers) {
      handler(subject, signal);
    }
  };

  return relay;
}

/** The bot's own Telegram identity, as grammy exposes it on `ctx.me`. */
export const BOT_IDENTITY = { id: 777, is_bot: true, first_name: 'DorkBot', username: 'dorkbot' };

export function createInboundCtx(overrides: {
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup' | 'channel';
  text?: string;
  firstName?: string;
  lastName?: string;
  username?: string;
  fromId?: number;
  messageId?: number;
  title?: string;
  /** Entities Telegram attached to the text (mentions, commands). */
  entities?: Array<Record<string, unknown>>;
}) {
  const {
    chatId = 12345,
    chatType = 'private',
    text = 'Hello agent!',
    firstName = 'Alice',
    lastName = undefined,
    username = 'alice',
    fromId = 99,
    messageId = 1,
    title,
    entities,
  } = overrides;

  return {
    chat: { id: chatId, type: chatType, ...(title ? { title } : {}) },
    from: { id: fromId, is_bot: false, first_name: firstName, last_name: lastName, username },
    me: BOT_IDENTITY,
    message: { text, message_id: messageId, caption: undefined, entities },
  };
}

export function createEnvelope(subject: string, payload: unknown) {
  return {
    id: 'env-01',
    subject,
    from: 'relay.agent.backend',
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 3_600_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload,
  };
}
