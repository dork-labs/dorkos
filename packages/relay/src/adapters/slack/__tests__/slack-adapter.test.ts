import { sendPrivateSlackNotification } from '../private-notification.js';
vi.mock('../private-notification.js', () => ({ sendPrivateSlackNotification: vi.fn() }));
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter } from '../index.js';
import { createMockRelay } from '../../../__tests__/fixtures.js';
import type { RelayPublisher } from '../../../types.js';
import type { z } from 'zod';
import { SlackAdapterConfigSchema } from '@dorkos/shared/relay-schemas';
import type { SlackAdapterConfig, RelayLogger } from '../../../types.js';

/**
 * A Slack adapter config with schema defaults filled in.
 *
 * Built through `SlackAdapterConfigSchema` rather than as an object literal so
 * the fixture inherits every default the real config path applies (`streaming`,
 * `respondMode`, `dmPolicy`, …). A new field with a default lands here for free
 * instead of breaking every call site.
 */
function slackConfig(overrides: z.input<typeof SlackAdapterConfigSchema>): SlackAdapterConfig {
  return SlackAdapterConfigSchema.parse(overrides);
}

// Mock @slack/bolt
const mockAppStart = vi.fn().mockResolvedValue(undefined);
const mockAppStop = vi.fn().mockResolvedValue(undefined);
const mockAuthTest = vi.fn().mockResolvedValue({ user_id: 'U_BOT', user: 'dorkos_bot' });
const mockPostMessage = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
const mockChatUpdate = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
const mockPostEphemeral = vi.fn().mockResolvedValue({ ok: true });
let capturedMessageHandler: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let capturedMentionHandler: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let capturedErrorHandler: ((error: Error) => Promise<void>) | null = null;
/** Bolt action handlers by `action_id` — how the approve/deny buttons are driven. */
const capturedActionHandlers = new Map<string, (args: Record<string, unknown>) => Promise<void>>();

const mockReactionsAdd = vi.fn().mockResolvedValue({ ok: true });
const mockReactionsRemove = vi.fn().mockResolvedValue({ ok: true });
const mockSetStatus = vi.fn().mockResolvedValue({ ok: true });

/** Options the adapter passed to the most recent `new App(...)` (DOR-1542: proxy wiring). */
let capturedAppOptions: Record<string, unknown> | null = null;
/** Options the adapter passed to the most recent `new SocketModeReceiver(...)`, or `null` if none was constructed. */
let capturedSocketModeReceiverOptions: Record<string, unknown> | null = null;

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = {
      auth: { test: mockAuthTest },
      chat: {
        postMessage: mockPostMessage,
        update: mockChatUpdate,
        postEphemeral: mockPostEphemeral,
      },
      reactions: { add: mockReactionsAdd, remove: mockReactionsRemove },
      assistant: { threads: { setStatus: mockSetStatus } },
    };

    constructor(options: Record<string, unknown>) {
      capturedAppOptions = options;
    }

    message(handler: (args: Record<string, unknown>) => Promise<void>) {
      capturedMessageHandler = handler;
    }

    event(eventName: string, handler: (args: Record<string, unknown>) => Promise<void>) {
      if (eventName === 'app_mention') capturedMentionHandler = handler;
    }

    action(actionId: string, handler: (args: Record<string, unknown>) => Promise<void>) {
      capturedActionHandlers.set(actionId, handler);
    }

    error(handler: (error: Error) => Promise<void>) {
      capturedErrorHandler = handler;
    }

    async start() {
      return mockAppStart();
    }
    async stop() {
      return mockAppStop();
    }
  }

  class MockSocketModeReceiver {
    constructor(options: Record<string, unknown>) {
      capturedSocketModeReceiverOptions = options;
    }
  }

  return { App: MockApp, SocketModeReceiver: MockSocketModeReceiver, LogLevel: { WARN: 'warn' } };
});

/** Options the adapter passed to the most recent `new WebClient(...)` (DOR-1542: proxy wiring). */
let capturedWebClientOptions: Record<string, unknown> | undefined;

vi.mock('@slack/web-api', () => {
  class MockWebClient {
    auth = { test: mockAuthTest };
    constructor(_token: string, options?: Record<string, unknown>) {
      capturedWebClientOptions = options;
    }
  }
  // Mirrors the real @slack/web-api 8 class closely enough for `instanceof`:
  // a platform error carries the Slack error string in `data.error` while its
  // `code` is always the same SDK-level constant.
  class MockWebAPIPlatformError extends Error {
    readonly code = 'slack_webapi_platform_error';
    constructor(readonly data: { ok: false; error: string }) {
      super('An API error occurred');
    }
  }
  return { WebClient: MockWebClient, WebAPIPlatformError: MockWebAPIPlatformError };
});

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;
  let mockRelay: RelayPublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    capturedMentionHandler = null;
    capturedErrorHandler = null;
    capturedActionHandlers.clear();
    capturedAppOptions = null;
    capturedSocketModeReceiverOptions = null;
    capturedWebClientOptions = undefined;
    adapter = new SlackAdapter(
      'slack-1',
      slackConfig({
        botToken: 'xoxb-test-token',
        appToken: 'xapp-test-token',
        signingSecret: 'test-signing-secret',
      })
    );
    mockRelay = createMockRelay();
  });

  afterEach(async () => {
    if (adapter.getStatus().state !== 'disconnected') {
      try {
        await adapter.stop();
      } catch {
        // ignore
      }
    }
  });

  it.each(['stop', 'restart'] as const)(
    'fences a private notification when the native client changes via %s',
    async (action) => {
      await adapter.start(mockRelay);
      const source = vi.fn(() => true);
      vi.mocked(sendPrivateSlackNotification).mockImplementationOnce(async (input) => {
        await adapter.stop();
        if (action === 'restart') await adapter.start(mockRelay);
        return input.authorizeDispatch()
          ? { state: 'delivered', receiptId: 'unexpected' }
          : { state: 'refused' };
      });
      expect(
        await adapter.deliverPrivateNotification(
          'relay.human.slack.slack-1.C123',
          'private',
          source
        )
      ).toEqual({ state: 'refused' });
      expect(source).not.toHaveBeenCalled();
    }
  );

  // Corporate-proxy support (DOR-1542): @slack/web-api 8 and @slack/socket-mode moved from
  // axios (which honored HTTP_PROXY/HTTPS_PROXY automatically) to native fetch, which does
  // not. These assert the wiring end to end (real @slack/web-api and undici types, mocked
  // @slack/bolt) — that a proxy env var actually reaches both SDKs, that HTTP(S)_PROXY alone
  // is what triggers it (not NO_PROXY, which alone means "use no proxy" — DOR-1542 review,
  // F5), and only then: an install with none of HTTP_PROXY/HTTPS_PROXY set must see no change
  // in what gets passed to the SDKs. Whether the returned transport actually tunnels traffic
  // through a proxy is proven against the real mechanism in proxy.test.ts, not here.
  describe('proxy support (DOR-1542)', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('wires a fetch and a SocketModeReceiver dispatcher when HTTPS_PROXY is set, both dispatching through the same instance', async () => {
      vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.com:8080');

      await adapter.start(mockRelay);

      const clientOptions = capturedAppOptions?.clientOptions as { fetch?: unknown } | undefined;
      expect(typeof clientOptions?.fetch).toBe('function');
      expect(capturedSocketModeReceiverOptions).not.toBeNull();
      expect(capturedSocketModeReceiverOptions?.appToken).toBe('xapp-test-token');
      expect(capturedSocketModeReceiverOptions?.dispatcher).toBeDefined();

      // Identity, not just presence: spy on the *exact* dispatcher instance
      // handed to the SocketModeReceiver, then drive the WebClient fetch and
      // confirm it dispatches through that same object. If `_start()` ever
      // built two separate transports instead of sharing one, this spy would
      // never fire and the test would fail (DOR-1542 review, F4).
      const dispatcher = capturedSocketModeReceiverOptions?.dispatcher as {
        dispatch: (...args: unknown[]) => boolean;
      };
      const dispatchSpy = vi.spyOn(dispatcher, 'dispatch');
      const fetch = clientOptions?.fetch as (url: string) => Promise<unknown>;
      await fetch('https://slack.invalid.test/api/auth.test').catch(() => {
        // Expected: nothing is actually listening on that host in a unit test.
      });
      expect(dispatchSpy).toHaveBeenCalled();

      await adapter.testConnection();
      const webClientOptions = capturedWebClientOptions as { fetch?: unknown } | undefined;
      expect(typeof webClientOptions?.fetch).toBe('function');
    });

    it('_stop() closes the proxy dispatcher _start() opened', async () => {
      vi.stubEnv('HTTPS_PROXY', 'http://proxy.example.com:8080');
      await adapter.start(mockRelay);

      const dispatcher = capturedSocketModeReceiverOptions?.dispatcher as {
        close: () => Promise<void>;
      };
      const closeSpy = vi.spyOn(dispatcher, 'close');

      await adapter.stop();

      // Not toHaveBeenCalledTimes(1): undici's DispatcherBase#close(), called
      // with no arguments, wraps itself in a Promise by recursively calling
      // `this.close(callback)` once more internally — so a single logical
      // close from our code always shows up as 2 recorded calls on this spy.
      // What we're actually asserting is that _stop() calls close() at all.
      expect(closeSpy).toHaveBeenCalled();
    });
  });

  // Timeout on auth.test()

  // Stop
  it('stop() calls app.stop() and transitions to disconnected', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();
    expect(mockAppStop).toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  // Deliver
  it('deliver() delegates to outbound module and posts to Slack', async () => {
    await adapter.start(mockRelay);
    const envelope = {
      id: 'e1',
      subject: 'relay.human.slack.slack-1.D123',
      from: 'relay.agent.backend',
      budget: {
        hopCount: 0,
        maxHops: 5,
        ancestorChain: [],
        ttl: Date.now() + 3_600_000,
        callBudgetRemaining: 10,
      },
      createdAt: new Date().toISOString(),
      payload: { content: 'Hello from agent!' },
    };
    const result = await adapter.deliver('relay.human.slack.slack-1.D123', envelope);
    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalled();
  });

  // Duplicate mention delivery (message + app_mention for the same message)
  describe('channel @mention dedup', () => {
    it('processes a channel @mention once when Slack delivers it as both message and app_mention', async () => {
      await adapter.start(mockRelay);
      expect(capturedMessageHandler).toBeDefined();
      expect(capturedMentionHandler).toBeDefined();

      // Slack sends the same underlying message as two events with DISTINCT
      // event_ids — event_id dedup alone misses the pair.
      const event = {
        type: 'message',
        user: 'U999',
        text: '<@U_BOT> deploy please',
        channel: 'C123',
        ts: '1717171717.000100',
      };
      // `typingIndicator` defaults to 'reaction', so the adapter adds one.
      const client = {
        users: {},
        conversations: {},
        reactions: { add: vi.fn().mockResolvedValue({ ok: true }) },
      };

      await capturedMessageHandler!({ event, client, body: { event_id: 'Ev-AAA' } });
      await capturedMentionHandler!({
        event: { ...event, type: 'app_mention' },
        client,
        body: { event_id: 'Ev-BBB' },
      });

      expect(mockRelay.publish).toHaveBeenCalledTimes(1);
    });
  });

  // Fatal error handling
  describe('fatal Slack error detection', () => {
    /**
     * Drive the error handler and wait for the teardown it queues.
     *
     * The adapter defers stopping to a later tick (it is called from inside
     * Bolt's own error handler), so the assertions have to wait for the queued
     * work rather than read status straight after the handler resolves.
     */
    async function deliverFatalError(error: unknown): Promise<void> {
      await capturedErrorHandler!(error as Error);
      await vi.waitFor(() => {
        expect(adapter.getStatus().lastError).toContain('Re-check your bot token');
      });
    }

    it.each([
      ['on its code', { code: 'invalid_auth' }, 'invalid_auth'],
      ['in its data.error field', { data: { error: 'token_revoked' } }, 'token_revoked'],
    ])('stops the adapter on a fatal error code %s', async (_where, fields, code) => {
      await adapter.start(mockRelay);

      await deliverFatalError(Object.assign(new Error('An API error occurred'), fields));

      expect(mockAppStop).toHaveBeenCalled();
      const status = adapter.getStatus();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain(code);
      expect(status.lastError).toContain('Re-check your bot token');
    });

    it('stops the adapter on a real WebAPIPlatformError, whose code is never the Slack error', async () => {
      // The shape Slack actually throws: `data.error` holds 'invalid_auth'
      // while `code` is the constant 'slack_webapi_platform_error'. Reading
      // `code` first shadowed the real string and no fatal error ever matched
      // — the two tests above missed it because neither shape carried both
      // fields at once (DOR-1528).
      const { WebAPIPlatformError } = await import('@slack/web-api');
      await adapter.start(mockRelay);

      await deliverFatalError(new WebAPIPlatformError({ ok: false, error: 'invalid_auth' }));

      expect(mockAppStop).toHaveBeenCalled();
      const status = adapter.getStatus();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('invalid_auth');
      expect(status.lastError).not.toContain('slack_webapi_platform_error');
    });

    it('survives a self-referential error chain without hanging', async () => {
      // The unwrap walk follows `original`/`cause`/`originals`, so a cycle must
      // terminate on the depth guard rather than recurse forever.
      await adapter.start(mockRelay);
      const cyclic: { code: string; cause?: unknown } = { code: 'boom' };
      cyclic.cause = cyclic;

      await capturedErrorHandler!(cyclic as unknown as Error);

      expect(mockAppStop).not.toHaveBeenCalled();
      expect(adapter.getStatus().state).toBe('error');
    });

    it('runs the full stop path, not just app.stop(), so timers are cleared', async () => {
      // Calling `app.stop()` directly left `this.app` set and skipped `_stop()`,
      // so the approval and presence timers kept firing against a dead token.
      // Going through `stop()` clears them and nulls the app — observable here
      // because a follow-up stop() then has no app left to stop (DOR-1528).
      const { WebAPIPlatformError } = await import('@slack/web-api');
      await adapter.start(mockRelay);
      mockAppStop.mockClear();

      await deliverFatalError(new WebAPIPlatformError({ ok: false, error: 'invalid_auth' }));
      await adapter.stop();

      expect(mockAppStop).toHaveBeenCalledTimes(1);
    });
  });

  /**
   * DOR-609. The approval card is posted into the conversation that asked for
   * the turn, so without this gate the person who sent the triggering message
   * could approve their own tool call with one tap. `respondedBy` recorded who
   * acted; nothing decided who may.
   */
  describe('approval authorization', () => {
    const BUTTON_VALUE = JSON.stringify({
      toolCallId: 'toolu_1',
      sessionId: 'sess-1',
      agentId: 'agent-1',
    });

    /** Start the adapter and press Approve as `userId`. */
    async function pressApproveAs(userId: string, config?: SlackAdapterConfig) {
      if (config) {
        await adapter.stop().catch(() => {});
        adapter = new SlackAdapter('slack-1', config);
      }
      await adapter.start(mockRelay);
      vi.mocked(mockRelay.publish).mockClear();

      const handler = capturedActionHandlers.get('tool_approve');
      expect(handler).toBeDefined();
      const ack = vi.fn().mockResolvedValue(undefined);
      await handler!({
        ack,
        action: { value: BUTTON_VALUE },
        body: {
          user: { id: userId },
          channel: { id: 'C_GENERAL' },
          message: { ts: 'msg-ts-1' },
        },
        client: {
          chat: {
            postMessage: mockPostMessage,
            update: mockChatUpdate,
            postEphemeral: mockPostEphemeral,
          },
        },
      });
      return { ack };
    }

    const withApprovers = (approvers: string[]) =>
      slackConfig({
        botToken: 'xoxb-test-token',
        appToken: 'xapp-test-token',
        signingSecret: 'test-signing-secret',
        approverAllowlist: approvers,
      });

    it('refuses a user who is not on the approver list', async () => {
      await pressApproveAs('U_ATTACKER', withApprovers(['U_OPERATOR']));

      expect(mockRelay.publish).not.toHaveBeenCalled();
      expect(mockChatUpdate).not.toHaveBeenCalled();
      expect(mockPostEphemeral).toHaveBeenCalledWith(
        expect.objectContaining({ user: 'U_ATTACKER' })
      );
    });

    it('refuses everyone when no approver list is configured', async () => {
      await pressApproveAs('U_OPERATOR');

      expect(mockRelay.publish).not.toHaveBeenCalled();
      expect(mockChatUpdate).not.toHaveBeenCalled();
    });

    it('lets a named approver through', async () => {
      await pressApproveAs('U_OPERATOR', withApprovers(['U_OPERATOR']));

      expect(mockRelay.publish).toHaveBeenCalledWith(
        'relay.system.approval.agent-1',
        expect.objectContaining({
          type: 'approval_response',
          toolCallId: 'toolu_1',
          approved: true,
          respondedBy: 'U_OPERATOR',
          platform: 'slack',
        }),
        { from: 'relay.system.approval-bridge.slack.slack-1' }
      );
    });

    it('refuses a deny from an unauthorized user too', async () => {
      await adapter.stop().catch(() => {});
      adapter = new SlackAdapter('slack-1', withApprovers(['U_OPERATOR']));
      await adapter.start(mockRelay);
      vi.mocked(mockRelay.publish).mockClear();

      const ack = vi.fn().mockResolvedValue(undefined);
      await capturedActionHandlers.get('tool_deny')!({
        ack,
        action: { value: BUTTON_VALUE },
        body: { user: { id: 'U_ATTACKER' }, channel: { id: 'C1' }, message: { ts: 't1' } },
        client: { chat: { update: mockChatUpdate, postEphemeral: mockPostEphemeral } },
      });

      expect(mockRelay.publish).not.toHaveBeenCalled();
    });
  });

  /**
   * DOR-1509. `@slack/web-api` calls made inside `handleToolAction` (relay
   * publish, `chat.postEphemeral`, `chat.update`) can reject with a real
   * `AxiosError`, and axios's `AxiosError.toJSON()` — invoked implicitly by
   * anything that stringifies or spreads the error, including a naive
   * `logger.error('...', err)` — serializes the full request config,
   * `Authorization: Bearer <bot token>` header included. A caught error must
   * never reach a logger call raw.
   */
  describe('error logging never leaks the bot token (DOR-1509)', () => {
    const LEAKED_TOKEN = 'xoxb-should-never-appear-in-logs';

    /** Reproduces the axios rejection shape without depending on axios itself. */
    class FakeAxiosError extends Error {
      readonly isAxiosError = true;
      readonly code = 'ERR_BAD_REQUEST';
      readonly config = {
        url: 'https://slack.com/api/chat.postMessage',
        headers: { Authorization: `Bearer ${LEAKED_TOKEN}` },
      };
      toJSON() {
        return { message: this.message, name: this.name, code: this.code, config: this.config };
      }
    }

    it('keeps the token out of every logger call when a Slack API call throws an AxiosError-shaped rejection', async () => {
      const logger: RelayLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
      adapter = new SlackAdapter(
        'slack-1',
        slackConfig({
          botToken: 'xoxb-test-token',
          appToken: 'xapp-test-token',
          signingSecret: 'test-signing-secret',
          approverAllowlist: ['U_OPERATOR'],
        })
      );
      adapter.setLogger(logger);
      await adapter.start(mockRelay);

      vi.mocked(mockRelay.publish).mockRejectedValueOnce(
        new FakeAxiosError('Request failed with status code 401')
      );

      const handler = capturedActionHandlers.get('tool_approve');
      expect(handler).toBeDefined();
      await handler!({
        ack: vi.fn().mockResolvedValue(undefined),
        action: {
          value: JSON.stringify({ toolCallId: 'toolu_1', sessionId: 'sess-1', agentId: 'agent-1' }),
        },
        body: {
          user: { id: 'U_OPERATOR' },
          channel: { id: 'C_GENERAL' },
          message: { ts: 'msg-ts-1' },
        },
        client: { chat: { update: mockChatUpdate, postEphemeral: mockPostEphemeral } },
      });

      expect(logger.error).toHaveBeenCalledWith(
        '[Slack] tool action handler error:',
        expect.objectContaining({ message: expect.stringContaining('401') })
      );

      // The load-bearing assertion. `JSON.stringify` calls a nested object's
      // `.toJSON()` implicitly (that's the exact mechanism axios exploits), so
      // stringifying every argument ever handed to the mock logger is what a
      // regression back to `logger.error('...', err)` would actually fail —
      // asserting the error object was never passed by identity would not
      // catch a spread or a rebuilt copy that still carries `config`.
      const everyLoggedArg = [
        ...vi.mocked(logger.debug).mock.calls,
        ...vi.mocked(logger.info).mock.calls,
        ...vi.mocked(logger.warn).mock.calls,
        ...vi.mocked(logger.error).mock.calls,
      ];
      const serialized = JSON.stringify(everyLoggedArg);
      expect(serialized).not.toContain(LEAKED_TOKEN);
      expect(serialized).not.toContain('Authorization');
    });
  });
});
