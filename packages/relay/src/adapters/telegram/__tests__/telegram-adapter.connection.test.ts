import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { TelegramAdapter } from '../index.js';
import type { RelayLogger } from '../../../types.js';
import {
  captured,
  createEnvelope,
  createMockRelay,
  mockBotInit,
  mockBotStart,
  mockBotStop,
  mockDeleteWebhook,
  mockSendMessage,
  mockServerClose,
  mockServerCloseAllConnections,
  mockSetWebhook,
  resetCaptured,
  tgConfig,
} from './telegram-adapter.fixtures.js';

vi.mock('node:http', async () => (await import('./telegram-adapter.fixtures.js')).httpModule());
vi.mock('grammy', async () => (await import('./telegram-adapter.fixtures.js')).grammyModule());
vi.mock('@grammyjs/auto-retry', async () =>
  (await import('./telegram-adapter.fixtures.js')).autoRetryModule()
);

describe('TelegramAdapter', () => {
  let adapter: TelegramAdapter;
  let mockRelay: ReturnType<typeof createMockRelay>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCaptured();

    // User 42 is the approver these tests press buttons as. Without a named
    // approver every approval is refused, which is the point of DOR-609 — the
    // refusal path has its own tests below.
    //
    // User 99 is `createInboundCtx`'s default author, and private chats now
    // need an allowlist (DOR-788), so it is named here. These tests are about
    // subjects and payload shapes; the allowlist has its own tests in
    // `inbound.test.ts`.
    adapter = new TelegramAdapter(
      'tg1',
      tgConfig({
        token: 'test-token',
        mode: 'polling',
        approverAllowlist: ['42'],
        dmAllowlist: ['99', '55'],
      })
    );
    mockRelay = createMockRelay();
  });

  afterEach(async () => {
    // Clean up adapter if started
    if (adapter.getStatus().state !== 'disconnected' && adapter.getStatus().state !== 'error') {
      try {
        await adapter.stop();
      } catch {
        // ignore cleanup errors
      }
    }
  });

  // --- C3: Webhook secret token ---

  it('webhook mode: passes secret_token to setWebhook and webhookCallback', async () => {
    const { webhookCallback } = await import('grammy');

    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
        webhookSecret: 'my-fixed-secret',
      })
    );

    await webhookAdapter.start(mockRelay);

    // setWebhook should receive the secret_token option
    expect(mockSetWebhook).toHaveBeenCalledWith('https://example.com/webhook', {
      secret_token: 'my-fixed-secret',
    });

    // webhookCallback should receive the secretToken option
    expect(webhookCallback).toHaveBeenCalledWith(expect.anything(), 'http', {
      secretToken: 'my-fixed-secret',
    });

    await webhookAdapter.stop();
  });

  it('webhook mode: auto-generates secret when webhookSecret is not provided', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);

    // Should still pass a secret_token (auto-generated)
    expect(mockSetWebhook).toHaveBeenCalledWith(
      'https://example.com/webhook',
      expect.objectContaining({ secret_token: expect.any(String) })
    );

    // The auto-generated secret should be non-empty
    const calledSecret = mockSetWebhook.mock.calls[0][1].secret_token as string;
    expect(calledSecret.length).toBeGreaterThan(0);

    await webhookAdapter.stop();
  });

  // --- I7: Polling reconnection with exponential backoff ---

  it('reconnects with backoff when polling fails', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects to simulate a polling failure
    let startCallCount = 0;
    mockBotStart.mockImplementation(async (opts?: { onStart?: () => void }) => {
      startCallCount++;
      if (startCallCount === 1) {
        // First call: succeeds initially then "crashes" — simulate with rejection
        if (opts?.onStart) opts.onStart();
        // After the polling loop "starts", simulate a late rejection
        throw new Error('Polling connection lost');
      }
      // Subsequent reconnect calls succeed
      if (opts?.onStart) opts.onStart();
    });

    await adapter.start(mockRelay);

    // Allow the .catch() handler on bot.start() to execute
    await vi.advanceTimersByTimeAsync(0);

    // Error should have been recorded
    expect(adapter.getStatus().errorCount).toBe(1);

    // Advance past first reconnect delay (5000ms)
    await vi.advanceTimersByTimeAsync(5_000);

    // The adapter should attempt to reconnect (new bot created and init called)
    // Initial init(1) + reconnect init(2)
    expect(mockBotInit).toHaveBeenCalledTimes(2);

    vi.useRealTimers();
  });

  // --- C1: Reconnection stops old bot before creating a new one ---

  it('reconnection stops old bot before creating a new one (C1)', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects immediately to trigger handlePollingError
    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);

    // Allow the .catch() on bot.start() to execute
    await vi.advanceTimersByTimeAsync(0);

    // Clear the call count from startup
    mockBotStop.mockClear();

    // Advance past first reconnect delay (5000ms) — timer fires, old bot.stop() is called
    await vi.advanceTimersByTimeAsync(5_000);

    // The old bot's stop() should have been called before the new bot was created
    expect(mockBotStop).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  // --- H4: Reconnect re-registers ALL handlers, not just message ---

  it('approval buttons work end-to-end after a polling reconnect (H4)', async () => {
    vi.useFakeTimers();

    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);
    await vi.advanceTimersByTimeAsync(0);
    captured.callbackQuery = null;
    await vi.advanceTimersByTimeAsync(5_000);
    vi.useRealTimers();

    // Deliver an approval card, then press Approve via the RE-REGISTERED handler
    const approvalEnvelope = createEnvelope('relay.human.telegram.tg1.12345', {
      type: 'approval_required',
      data: {
        toolCallId: 'toolu_reconnect',
        toolName: 'Write',
        input: '{"path":"src/index.ts"}',
        timeoutMs: 0,
        agentId: 'agent-1',
        ccaSessionKey: 'sess-abc',
      },
    });
    const deliverResult = await adapter.deliver('relay.human.telegram.tg1.12345', approvalEnvelope);
    expect(deliverResult.success).toBe(true);

    // Extract the callback_data Telegram would echo back on button press
    const sendCall = mockSendMessage.mock.calls.at(-1)!;
    const keyboard = (
      sendCall[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
    ).reply_markup.inline_keyboard[0];
    const approveData = keyboard[0].callback_data;

    const ctx = {
      callbackQuery: { data: approveData },
      from: { id: 42 },
      answerCallbackQuery: vi.fn().mockResolvedValue(true),
      editMessageText: vi.fn().mockResolvedValue(true),
    };
    await captured.callbackQuery!(ctx);

    expect(mockRelay.publish).toHaveBeenCalledWith(
      'relay.system.approval.agent-1',
      expect.objectContaining({
        type: 'approval_response',
        toolCallId: 'toolu_reconnect',
        sessionId: 'sess-abc',
        approved: true,
        respondedBy: '42',
        platform: 'telegram',
      }),
      { from: 'relay.system.approval-bridge.telegram.tg1' }
    );
    // Decision edit uses HTML parse mode (legacy Markdown hard-fails)
    expect(ctx.editMessageText).toHaveBeenCalledWith('✅ <b>Tool Approved</b>', {
      parse_mode: 'HTML',
    });
  });

  /**
   * DOR-609. The approval card lands in the same chat that asked for the turn,
   * so without this check the person who sent the message could approve their
   * own tool call with one tap. `respondedBy` recorded who acted; nothing
   * decided who may.
   */
  describe('approval authorization', () => {
    /** Deliver a card and press Approve as `userId`. */
    async function pressApproveAs(userId: number) {
      await adapter.start(mockRelay);
      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_auth',
          toolName: 'Bash',
          input: '{"command":"rm -rf ~"}',
          timeoutMs: 0,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-abc',
        },
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      const sendCall = mockSendMessage.mock.calls.at(-1)!;
      const approveData = (
        sendCall[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
      ).reply_markup.inline_keyboard[0][0].callback_data;

      const ctx = {
        callbackQuery: { data: approveData },
        from: { id: userId },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      };
      vi.mocked(mockRelay.publish).mockClear();
      await captured.callbackQuery!(ctx);
      return ctx;
    }

    it('refuses a user who is not on the approver list', async () => {
      const ctx = await pressApproveAs(9999);

      expect(mockRelay.publish).not.toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
      expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
        expect.objectContaining({ show_alert: true })
      );
    });

    it('allows the named approver', async () => {
      await pressApproveAs(42);

      expect(mockRelay.publish).toHaveBeenCalledWith(
        'relay.system.approval.agent-1',
        expect.objectContaining({ approved: true, respondedBy: '42' }),
        { from: 'relay.system.approval-bridge.telegram.tg1' }
      );
    });

    it('refuses everyone when no approver list is configured', async () => {
      adapter = new TelegramAdapter('tg1', tgConfig({ token: 'test-token', mode: 'polling' }));
      const ctx = await pressApproveAs(42);

      expect(mockRelay.publish).not.toHaveBeenCalled();
      expect(ctx.editMessageText).not.toHaveBeenCalled();
    });
  });

  /**
   * DOR-1509. grammY builds its request URL as
   * `https://api.telegram.org/bot<TOKEN>/<method>` — the bot token lives in
   * the URL path, not a header. On Node, grammY fetches through `node-fetch`,
   * whose `FetchError` bakes that URL directly into its own top-level
   * `.message` for every network-level failure (timeout, connection refused,
   * DNS failure, a bad redirect — confirmed against `node-fetch@2.7.0`'s
   * `lib/index.js`, e.g. `` `request to ${request.url} failed, reason: ...` ``).
   * grammY wraps that in its own `HttpError`, whose *own* `.message` stays
   * safe by default (`sensitiveLogs` defaults to `false`, never overridden in
   * this repo) — but the raw, token-bearing `FetchError` still sits one
   * property access away, on `HttpError.error`. This reproduces exactly that
   * shape and asserts the nested property is never touched.
   */
  describe('error logging never leaks the bot token (DOR-1509)', () => {
    const LEAKED_TOKEN = 'should-never-appear-in-logs';

    /**
     * Reproduces node-fetch@2.7.0's real `FetchError` shape (the class
     * grammY throws on every network-level failure on Node), not just a
     * plain `Error`. node-fetch predates ES6 classes: its `FetchError`
     * constructor calls `Error.call(this, message)` and then explicitly does
     * `this.message = message` — which, unlike a `class X extends Error`
     * subclass's `super()` (confirmed empirically: a bare `new Error(...)`
     * has NO own enumerable keys), makes `.message` an OWN ENUMERABLE
     * property. That is what lets the token-bearing URL survive
     * `JSON.stringify` and an object spread (`{...err}`) with no `toJSON()`
     * involved at all — exactly what DorkOS's own NDJSON file reporter does
     * with an object-shaped second logger argument
     * (`apps/server/src/lib/logger.ts`'s `createFileReporter`: an object
     * second arg becomes `context`, spread as `{ ...context }` and
     * `JSON.stringify`d).
     */
    function fakeNodeFetchError(message: string): Error {
      const err = new Error(message);
      Object.defineProperty(err, 'message', { value: message, enumerable: true });
      return err;
    }

    class FakeGrammyHttpError extends Error {
      readonly error: unknown;
      constructor(safeMessage: string, rawFetchError: unknown) {
        super(safeMessage);
        this.name = 'HttpError';
        this.error = rawFetchError;
      }
    }

    it('keeps the bot token out of every logger call when a Telegram send fails at the network level', async () => {
      const logger: RelayLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      adapter.setLogger(logger);
      await adapter.start(mockRelay);

      const leakedUrl = `https://api.telegram.org/bot${LEAKED_TOKEN}/sendMessage`;
      const rawFetchError = fakeNodeFetchError(
        `request to ${leakedUrl} failed, reason: getaddrinfo ENOTFOUND api.telegram.org`
      );
      const safeMessage = "Network request for 'sendMessage' failed!";

      const envelope = createEnvelope('relay.human.telegram.tg1.12345', {
        type: 'approval_required',
        data: {
          toolCallId: 'toolu_leak',
          toolName: 'Bash',
          input: '{"command":"echo hi"}',
          timeoutMs: 0,
          agentId: 'agent-1',
          ccaSessionKey: 'sess-leak',
        },
      });
      await adapter.deliver('relay.human.telegram.tg1.12345', envelope);

      const sendCall = mockSendMessage.mock.calls.at(-1)!;
      const approveData = (
        sendCall[2] as { reply_markup: { inline_keyboard: { callback_data: string }[][] } }
      ).reply_markup.inline_keyboard[0][0].callback_data;

      vi.mocked(mockRelay.publish).mockRejectedValueOnce(
        new FakeGrammyHttpError(safeMessage, rawFetchError)
      );

      const ctx = {
        callbackQuery: { data: approveData },
        from: { id: 42 },
        answerCallbackQuery: vi.fn().mockResolvedValue(true),
        editMessageText: vi.fn().mockResolvedValue(true),
      };
      await captured.callbackQuery!(ctx);

      expect(logger.error).toHaveBeenCalledWith(
        '[Telegram] callback query handler error:',
        expect.objectContaining({ message: safeMessage })
      );

      // Load-bearing: scans every argument ever handed to every logger method,
      // stringified, the same way a regression back to
      // `logger.error('...', err)` would actually surface the leak (reading
      // `err.error.message` directly, or spreading `err`, would put the URL —
      // and the token in it — into this string).
      const everyLoggedArg = [
        ...vi.mocked(logger.debug).mock.calls,
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
        ...vi.mocked(logger.error).mock.calls,
      ];
      const serialized = JSON.stringify(everyLoggedArg);
      expect(serialized).not.toContain(LEAKED_TOKEN);
      expect(serialized).not.toContain(leakedUrl);
    });
  });

  // --- C2: stop() clears pending reconnect timer ---

  it('stop() clears pending reconnect timer so it does not fire after stop (C2)', async () => {
    vi.useFakeTimers();

    // First bot.start() rejects immediately to trigger handlePollingError
    mockBotStart.mockImplementationOnce(async (opts?: { onStart?: () => void }) => {
      if (opts?.onStart) opts.onStart();
      throw new Error('Polling connection lost');
    });

    await adapter.start(mockRelay);

    // Allow the .catch() on bot.start() to execute — error is recorded
    await vi.advanceTimersByTimeAsync(0);

    // Stop the adapter while the reconnect timer is still pending
    await adapter.stop();

    // Clear call counts so we can detect any spurious calls
    mockBotInit.mockClear();
    mockBotStart.mockClear();

    // Advance past the reconnect delay — the timer should NOT fire
    await vi.advanceTimersByTimeAsync(10_000);

    // No new polling loop should have been started
    expect(mockBotInit).not.toHaveBeenCalled();
    expect(mockBotStart).not.toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe('disconnected');

    vi.useRealTimers();
  });

  it('stop() calls closeAllConnections() before server.close() (C5)', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);

    // Capture call order by recording the sequence of calls
    const callOrder: string[] = [];
    mockServerCloseAllConnections.mockImplementation(() => callOrder.push('closeAllConnections'));
    mockServerClose.mockImplementation((cb?: (err?: Error) => void) => {
      callOrder.push('close');
      cb?.();
    });

    await webhookAdapter.stop();

    expect(callOrder).toEqual(['closeAllConnections', 'close']);
  });

  // --- M8: Webhook cleanup on stop ---

  it('stop() calls deleteWebhook() in webhook mode (M8)', async () => {
    const webhookAdapter = new TelegramAdapter(
      'tg-webhook',
      tgConfig({
        token: 'test-token',
        mode: 'webhook',
        webhookUrl: 'https://example.com/webhook',
        webhookPort: 8443,
      })
    );

    await webhookAdapter.start(mockRelay);
    await webhookAdapter.stop();

    expect(mockDeleteWebhook).toHaveBeenCalledOnce();
  });

  // --- Timeout on bot.init() ---

  it('start() rejects when bot.init() hangs beyond INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    // Suppress the expected unhandled rejection from the timeout race under fake timers
    const suppress = () => {};
    process.on('unhandledRejection', suppress);

    mockBotInit.mockReturnValue(new Promise(() => {})); // never resolves

    const startPromise = adapter.start(mockRelay);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(startPromise).rejects.toThrow('timed out');

    mockBotInit.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('unhandledRejection', suppress);
    vi.useRealTimers();
  });
});
