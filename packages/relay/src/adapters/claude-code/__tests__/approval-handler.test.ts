import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, MessageHandler } from '../../../types.js';
import type { AgentRuntimeLike } from '../types.js';
import {
  subscribeApprovalHandler,
  handleApprovalResponse,
  APPROVAL_SUBJECT_PATTERN,
} from '../approval-handler.js';

// === Mock factories ===

function createMockAgentManager(): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        /* empty */
      })(),
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
  };
}

function createMockRelay(): RelayPublisher & { capturedHandler: MessageHandler | null } {
  const mock: RelayPublisher & { capturedHandler: MessageHandler | null } = {
    capturedHandler: null,
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockImplementation((_pattern: string, handler: MessageHandler) => {
      mock.capturedHandler = handler;
      return () => {};
    }),
  };
  return mock;
}

function createMockLogger() {
  return {
    warn: vi.fn(),
    debug: vi.fn(),
  };
}

function createApprovalEnvelope(
  overrides?: Partial<{ payload: Record<string, unknown> }>,
): RelayEnvelope {
  return {
    id: 'approval-msg-001',
    subject: 'relay.system.approval.slack',
    from: 'adapter:slack',
    replyTo: 'relay.human.slack.user-1',
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: {
      type: 'approval_response',
      toolCallId: 'tool-call-123',
      sessionId: 'session-abc',
      approved: true,
      respondedBy: 'U12345',
      platform: 'slack',
    },
    ...overrides,
  };
}

// === Test suite ===

describe('approval-handler', () => {
  let agentManager: AgentRuntimeLike;
  let relay: ReturnType<typeof createMockRelay>;
  let log: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    agentManager = createMockAgentManager();
    relay = createMockRelay();
    log = createMockLogger();
  });

  describe('subscribeApprovalHandler', () => {
    it('subscribes to relay.system.approval.> pattern', () => {
      subscribeApprovalHandler(relay, agentManager, log);

      expect(relay.subscribe).toHaveBeenCalledOnce();
      expect(relay.subscribe).toHaveBeenCalledWith(
        APPROVAL_SUBJECT_PATTERN,
        expect.any(Function),
      );
    });

    it('returns an unsubscribe function', () => {
      const unsub = vi.fn();
      vi.mocked(relay.subscribe).mockReturnValue(unsub);

      const result = subscribeApprovalHandler(relay, agentManager, log);
      expect(result).toBe(unsub);
    });

    it('routes incoming envelopes to handleApprovalResponse via the callback', () => {
      subscribeApprovalHandler(relay, agentManager, log);

      const envelope = createApprovalEnvelope();
      relay.capturedHandler!(envelope);

      expect(agentManager.approveTool).toHaveBeenCalledWith(
        'session-abc',
        'tool-call-123',
        true,
      );
    });
  });

  describe('handleApprovalResponse', () => {
    it('calls approveTool with correct args when approved', () => {
      const envelope = createApprovalEnvelope();
      handleApprovalResponse(envelope, agentManager, log);

      expect(agentManager.approveTool).toHaveBeenCalledWith(
        'session-abc',
        'tool-call-123',
        true,
      );
    });

    it('calls approveTool with approved=false for denial', () => {
      const envelope = createApprovalEnvelope({
        payload: {
          type: 'approval_response',
          toolCallId: 'tool-deny-456',
          sessionId: 'session-xyz',
          approved: false,
          respondedBy: 'U99999',
          platform: 'telegram',
        },
      });

      handleApprovalResponse(envelope, agentManager, log);

      expect(agentManager.approveTool).toHaveBeenCalledWith(
        'session-xyz',
        'tool-deny-456',
        false,
      );
    });

    it('logs debug message with approval details', () => {
      const envelope = createApprovalEnvelope();
      handleApprovalResponse(envelope, agentManager, log);

      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining('approve'),
      );
      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining('tool-call-123'),
      );
    });

    it('logs debug message with deny details', () => {
      const envelope = createApprovalEnvelope({
        payload: {
          type: 'approval_response',
          toolCallId: 'tool-789',
          sessionId: 'session-def',
          approved: false,
          platform: 'slack',
        },
      });

      handleApprovalResponse(envelope, agentManager, log);

      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining('deny'),
      );
    });

    it('warns when approveTool returns false (interaction not found)', () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(false);

      const envelope = createApprovalEnvelope();
      handleApprovalResponse(envelope, agentManager, log);

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('interaction not found'),
      );
    });

    describe('malformed payloads', () => {
      it('does not crash when payload is null', () => {
        const envelope = createApprovalEnvelope({ payload: null as unknown as Record<string, unknown> });

        expect(() => handleApprovalResponse(envelope, agentManager, log)).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining('malformed payload'),
        );
      });

      it('does not crash when payload has wrong type field', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'something_else', toolCallId: 'tc-1', sessionId: 's-1', approved: true },
        });

        expect(() => handleApprovalResponse(envelope, agentManager, log)).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalled();
      });

      it('does not crash when toolCallId is missing', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'approval_response', sessionId: 's-1', approved: true },
        });

        expect(() => handleApprovalResponse(envelope, agentManager, log)).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('does not crash when sessionId is missing', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'approval_response', toolCallId: 'tc-1', approved: true },
        });

        expect(() => handleApprovalResponse(envelope, agentManager, log)).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('does not crash when approved is missing', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'approval_response', toolCallId: 'tc-1', sessionId: 's-1' },
        });

        expect(() => handleApprovalResponse(envelope, agentManager, log)).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('does not crash when payload is a string', () => {
        const envelope = createApprovalEnvelope({
          payload: 'not an object' as unknown as Record<string, unknown>,
        });

        expect(() => handleApprovalResponse(envelope, agentManager, log)).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });
    });

    it('defaults platform to "unknown" when not provided', () => {
      const envelope = createApprovalEnvelope({
        payload: {
          type: 'approval_response',
          toolCallId: 'tc-1',
          sessionId: 's-1',
          approved: true,
        },
      });

      handleApprovalResponse(envelope, agentManager, log);

      expect(log.debug).toHaveBeenCalledWith(
        expect.stringContaining('platform=unknown'),
      );
    });
  });
});
