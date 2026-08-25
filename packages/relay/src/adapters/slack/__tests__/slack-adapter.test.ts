import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter, SLACK_MANIFEST } from '../index.js';
import { createMockRelay } from '../../../__tests__/fixtures.js';
import type { RelayPublisher } from '../../../types.js';
import type { z } from 'zod';
import { SlackAdapterConfigSchema } from '@dorkos/shared/relay-schemas';
import type { SlackAdapterConfig } from '../../../types.js';

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
let capturedAssistantHandler: ((args: Record<string, unknown>) => Promise<void>) | null = null;

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

    message(handler: (args: Record<string, unknown>) => Promise<void>) {
      capturedMessageHandler = handler;
    }

    event(eventName: string, handler: (args: Record<string, unknown>) => Promise<void>) {
      if (eventName === 'app_mention') capturedMentionHandler = handler;
      if (eventName === 'assistant_thread_started') capturedAssistantHandler = handler;
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
  return { App: MockApp, LogLevel: { WARN: 'warn' } };
});

vi.mock('@slack/web-api', () => {
  class MockWebClient {
    auth = { test: mockAuthTest };
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
    capturedAssistantHandler = null;
    capturedErrorHandler = null;
    capturedActionHandlers.clear();
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

  // Identity
  it('has correct id, subjectPrefix, and displayName', () => {
    expect(adapter.id).toBe('slack-1');
    expect(adapter.subjectPrefix).toBe('relay.human.slack.slack-1');
    expect(adapter.displayName).toBe('Slack');
  });

  it('accepts custom displayName', () => {
    const custom = new SlackAdapter(
      's2',
      slackConfig({ botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 's' }),
      'Work Slack'
    );
    expect(custom.displayName).toBe('Work Slack');
  });

  // Initial status
  it('reports disconnected before start', () => {
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  // Start
  it('start() transitions to connected', async () => {
    await adapter.start(mockRelay);
    expect(adapter.getStatus().state).toBe('connected');
  });

  it('start() is idempotent — only calls app.start once', async () => {
    await adapter.start(mockRelay);
    await adapter.start(mockRelay);
    expect(mockAppStart).toHaveBeenCalledTimes(1);
  });

  it('start() registers message, app_mention, and global error handlers', async () => {
    await adapter.start(mockRelay);
    expect(capturedMessageHandler).toBeDefined();
    expect(capturedMentionHandler).toBeDefined();
    expect(capturedErrorHandler).toBeDefined();
  });

  it('global error handler records error in adapter status', async () => {
    await adapter.start(mockRelay);
    expect(capturedErrorHandler).toBeDefined();

    await capturedErrorHandler!(new Error('socket_disconnect'));
    const status = adapter.getStatus();
    expect(status.state).toBe('error');
    expect(status.lastError).toBe('socket_disconnect');
    expect(status.errorCount).toBe(1);
  });

  // Stop
  it('stop() calls app.stop() and transitions to disconnected', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();
    expect(mockAppStop).toHaveBeenCalled();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  it('stop() is idempotent — only calls app.stop once', async () => {
    await adapter.start(mockRelay);
    await adapter.stop();
    await adapter.stop();
    expect(mockAppStop).toHaveBeenCalledTimes(1);
  });

  // testConnection
  it('testConnection() validates token without starting Socket Mode', async () => {
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: true, botUsername: 'dorkos_bot' });
    expect(mockAppStart).not.toHaveBeenCalled();
  });

  it('testConnection() returns error on invalid token', async () => {
    mockAuthTest.mockRejectedValueOnce(new Error('invalid_auth'));
    const result = await adapter.testConnection();
    expect(result).toEqual({ ok: false, error: 'invalid_auth' });
  });

  it('testConnection() does not alter adapter state', async () => {
    await adapter.testConnection();
    expect(adapter.getStatus().state).toBe('disconnected');
  });

  // Timeout on auth.test()

  it('start() rejects when auth.test() hangs beyond INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    // Suppress the expected unhandled rejection from the timeout race under fake timers
    const suppress = () => {};
    process.on('unhandledRejection', suppress);

    mockAuthTest.mockReturnValue(new Promise(() => {})); // never resolves

    const startPromise = adapter.start(mockRelay);
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(startPromise).rejects.toThrow('timed out');

    // Reset mock so subsequent tests work
    mockAuthTest.mockResolvedValue({ user_id: 'U_BOT', user: 'dorkos_bot' });
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('unhandledRejection', suppress);
    vi.useRealTimers();
  });

  it('testConnection() rejects when auth.test() hangs beyond INIT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();

    const suppress = () => {};
    process.on('unhandledRejection', suppress);

    mockAuthTest.mockReturnValue(new Promise(() => {})); // never resolves

    const resultPromise = adapter.testConnection();
    await vi.advanceTimersByTimeAsync(15_000);

    const result = await resultPromise;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('timed out');

    mockAuthTest.mockResolvedValue({ user_id: 'U_BOT', user: 'dorkos_bot' });
    await vi.advanceTimersByTimeAsync(0);
    process.removeListener('unhandledRejection', suppress);
    vi.useRealTimers();
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

  // The assistant split panel is the one Slack surface with a status line, and
  // `assistant_thread_started` is the only thing that names it. Without this
  // wiring every surface would fall back to the emoji, which is the wrong idiom
  // in a panel that has somewhere better to say it.
  it('sets an assistant status, not a reaction, in a thread it saw start', async () => {
    await adapter.start(mockRelay);
    expect(capturedAssistantHandler).toBeDefined();

    await capturedAssistantHandler!({
      event: { assistant_thread: { channel_id: 'D123', thread_ts: '1234.0001' } },
    });

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
      payload: {
        type: 'text_delta',
        data: { text: 'working' },
        platformData: { ts: '1234.0001' },
      },
    };
    await adapter.deliver('relay.human.slack.slack-1.D123', envelope);

    expect(mockSetStatus).toHaveBeenCalledWith({
      channel_id: 'D123',
      thread_ts: '1234.0001',
      status: 'is working on it…',
    });
    expect(mockReactionsAdd).not.toHaveBeenCalled();
  });

  it('deliver() returns error when adapter is stopped', async () => {
    // Never started — client is null
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
      payload: { content: 'Hello' },
    };
    const result = await adapter.deliver('relay.human.slack.slack-1.D123', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not started');
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
    it('stops the adapter on fatal error code (e.g. invalid_auth)', async () => {
      await adapter.start(mockRelay);
      expect(capturedErrorHandler).toBeDefined();

      const fatalError = Object.assign(new Error('An API error occurred'), {
        code: 'invalid_auth',
      });
      await capturedErrorHandler!(fatalError);

      expect(mockAppStop).toHaveBeenCalled();
      const status = adapter.getStatus();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('invalid_auth');
      expect(status.lastError).toContain('Re-check your bot token');
    });

    it('stops the adapter when fatal error is in data.error field', async () => {
      await adapter.start(mockRelay);

      const fatalError = Object.assign(new Error('An API error occurred'), {
        data: { error: 'token_revoked' },
      });
      await capturedErrorHandler!(fatalError);

      expect(mockAppStop).toHaveBeenCalled();
      const status = adapter.getStatus();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('token_revoked');
    });

    it('stops the adapter on a real WebAPIPlatformError, whose code is never the Slack error', async () => {
      // The shape Slack actually throws: `data.error` holds 'invalid_auth'
      // while `code` is the constant 'slack_webapi_platform_error'. Reading
      // `code` first shadowed the real string and no fatal error ever matched
      // — the two tests above missed it because neither shape carried both
      // fields at once (DOR-1528).
      const { WebAPIPlatformError } = await import('@slack/web-api');
      await adapter.start(mockRelay);

      await capturedErrorHandler!(
        new WebAPIPlatformError({ ok: false, error: 'invalid_auth' }) as unknown as Error
      );

      expect(mockAppStop).toHaveBeenCalled();
      const status = adapter.getStatus();
      expect(status.state).toBe('error');
      expect(status.lastError).toContain('invalid_auth');
      expect(status.lastError).not.toContain('slack_webapi_platform_error');
    });

    it('records non-fatal errors without stopping the adapter', async () => {
      await adapter.start(mockRelay);
      mockAppStop.mockClear();

      await capturedErrorHandler!(new Error('rate_limited'));

      expect(mockAppStop).not.toHaveBeenCalled();
      const status = adapter.getStatus();
      expect(status.state).toBe('error');
      expect(status.lastError).toBe('rate_limited');
    });

    it('produces a descriptive error message mentioning bot token', async () => {
      await adapter.start(mockRelay);

      const fatalError = Object.assign(new Error('An API error occurred'), {
        code: 'app_uninstalled',
      });
      await capturedErrorHandler!(fatalError);

      const status = adapter.getStatus();
      expect(status.lastError).toMatch(/Fatal Slack error: app_uninstalled/);
      expect(status.lastError).toMatch(/Re-check your bot token and app configuration/);
    });
  });

  // getStatus defensiveness
  it('getStatus() returns a copy — external mutation does not affect internal state', () => {
    const status = adapter.getStatus();
    status.errorCount = 999;
    expect(adapter.getStatus().errorCount).toBe(0);
  });

  // SLACK_MANIFEST configFields
  describe('SLACK_MANIFEST configFields', () => {
    const fieldByKey = (key: string) => SLACK_MANIFEST.configFields.find((f) => f.key === key);

    it('includes respondMode, dmPolicy, dmAllowlist, and channelOverrides fields', () => {
      expect(fieldByKey('respondMode')).toBeDefined();
      expect(fieldByKey('dmPolicy')).toBeDefined();
      expect(fieldByKey('dmAllowlist')).toBeDefined();
      expect(fieldByKey('channelOverrides')).toBeDefined();
    });

    it('respondMode is a select field with radio-cards display', () => {
      const field = fieldByKey('respondMode')!;
      expect(field.type).toBe('select');
      expect(field.displayAs).toBe('radio-cards');
      expect(field.options).toHaveLength(3);
      expect(field.options!.map((o) => o.value)).toEqual([
        'thread-aware',
        'mention-only',
        'always',
      ]);
    });

    it('dmPolicy is a select field with radio-cards display', () => {
      const field = fieldByKey('dmPolicy')!;
      expect(field.type).toBe('select');
      expect(field.displayAs).toBe('radio-cards');
      expect(field.options).toHaveLength(2);
      expect(field.options!.map((o) => o.value)).toEqual(['open', 'allowlist']);
    });

    it('dmAllowlist is a textarea shown only when dmPolicy equals allowlist', () => {
      const field = fieldByKey('dmAllowlist')!;
      expect(field.type).toBe('textarea');
      expect(field.showWhen).toEqual({ field: 'dmPolicy', equals: 'allowlist' });
    });

    it('channelOverrides is a textarea field', () => {
      const field = fieldByKey('channelOverrides')!;
      expect(field.type).toBe('textarea');
    });

    it('all new fields are in the Access Control section', () => {
      const newKeys = ['respondMode', 'dmPolicy', 'dmAllowlist', 'channelOverrides'];
      for (const key of newKeys) {
        expect(fieldByKey(key)!.section).toBe('Access Control');
      }
    });

    it('typingIndicator description mentions enabled by default', () => {
      const field = fieldByKey('typingIndicator')!;
      expect(field.description).toContain('Enabled by default');
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
        { from: 'slack:U_OPERATOR' }
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
});
