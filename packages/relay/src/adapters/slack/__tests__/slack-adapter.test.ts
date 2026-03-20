import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SlackAdapter } from '../index.js';
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
    expect(adapter.subjectPrefix).toBe('relay.human.slack');
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

  // Deliver
  it('deliver() delegates to outbound module and posts to Slack', async () => {
    await adapter.start(mockRelay);
    const envelope = {
      id: 'e1',
      subject: 'relay.human.slack.D123',
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
    const result = await adapter.deliver('relay.human.slack.D123', envelope);
    expect(result.success).toBe(true);
    expect(mockPostMessage).toHaveBeenCalled();
  });

  it('deliver() returns error when adapter is stopped', async () => {
    // Never started — client is null
    const envelope = {
      id: 'e1',
      subject: 'relay.human.slack.D123',
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
    const result = await adapter.deliver('relay.human.slack.D123', envelope);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not started');
  });

  // getStatus defensiveness
  it('getStatus() returns a copy — external mutation does not affect internal state', () => {
    const status = adapter.getStatus();
    status.errorCount = 999;
    expect(adapter.getStatus().errorCount).toBe(0);
  });
});
