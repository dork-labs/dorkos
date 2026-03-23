import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter, SLACK_MANIFEST } from '../index.js';
import type { RelayPublisher } from '../../../types.js';

// Mock @slack/bolt
const mockAppStart = vi.fn().mockResolvedValue(undefined);
const mockAppStop = vi.fn().mockResolvedValue(undefined);
const mockAuthTest = vi.fn().mockResolvedValue({ user_id: 'U_BOT', user: 'dorkos_bot' });
const mockPostMessage = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
const mockChatUpdate = vi.fn().mockResolvedValue({ ts: 'msg-ts-1' });
let capturedMessageHandler: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let capturedMentionHandler: ((args: Record<string, unknown>) => Promise<void>) | null = null;
let capturedErrorHandler: ((error: Error) => Promise<void>) | null = null;

vi.mock('@slack/bolt', () => {
  class MockApp {
    client = {
      auth: { test: mockAuthTest },
      chat: { postMessage: mockPostMessage, update: mockChatUpdate },
    };

    message(handler: (args: Record<string, unknown>) => Promise<void>) {
      capturedMessageHandler = handler;
    }

    event(eventName: string, handler: (args: Record<string, unknown>) => Promise<void>) {
      if (eventName === 'app_mention') capturedMentionHandler = handler;
    }

    action(_actionId: string, _handler: (args: Record<string, unknown>) => Promise<void>) {
      // no-op for tests — action handlers tested via integration tests
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
  return { WebClient: MockWebClient };
});

function createMockRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'msg-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

describe('SlackAdapter', () => {
  let adapter: SlackAdapter;
  let mockRelay: RelayPublisher;

  beforeEach(() => {
    vi.clearAllMocks();
    capturedMessageHandler = null;
    capturedMentionHandler = null;
    capturedErrorHandler = null;
    adapter = new SlackAdapter('slack-1', {
      botToken: 'xoxb-test-token',
      appToken: 'xapp-test-token',
      signingSecret: 'test-signing-secret',
    });
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
      { botToken: 'xoxb-x', appToken: 'xapp-x', signingSecret: 's' },
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
});
