import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import type { RelayPublisher, MessageHandler } from '../../../types.js';
import type { AgentRuntimeLike } from '../types.js';
import {
  subscribeApprovalHandler,
  handleApprovalResponse,
  APPROVAL_SUBJECT_PATTERN,
  type ApprovalAuthorizer,
} from '../approval-handler.js';
import { approvalBridgePrincipal } from '../../../lib/approval-principal.js';

// === Mock factories ===

function createMockAgentManager(type?: string): AgentRuntimeLike {
  return {
    ...(type ? { type } : {}),
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockReturnValue(
      (async function* () {
        /* empty */
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
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

function createMockTraceStore() {
  return { insertSpan: vi.fn() };
}

/** The principal the Slack adapter publishes a person's click as. */
const SLACK_BRIDGE = approvalBridgePrincipal('slack', 'slack-main');

function createApprovalEnvelope(
  overrides?: Partial<{ payload: Record<string, unknown>; from: string }>
): RelayEnvelope {
  return {
    id: 'approval-msg-001',
    subject: 'relay.system.approval.slack',
    from: SLACK_BRIDGE,
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
  /**
   * The server-side gate, recording what it was asked. Every case that is not
   * ABOUT the gate lets the click through, so a refusal below is the case's own
   * doing and not the fixture's.
   */
  let authorize: Mock<ApprovalAuthorizer>;
  let traceStore: ReturnType<typeof createMockTraceStore>;

  beforeEach(() => {
    vi.clearAllMocks();
    agentManager = createMockAgentManager();
    relay = createMockRelay();
    log = createMockLogger();
    authorize = vi.fn(() => true);
    traceStore = createMockTraceStore();
  });

  describe('who may send an approval (DOR-2431)', () => {
    // A forged approval names a real session and a real pending tool call: the
    // agent that is waiting on the card knows both. What it cannot choose is
    // the envelope's `from`, which the publish pipeline stamps.
    const OWN_SESSION = 'session-abc';
    const OWN_TOOL_CALL = 'tool-call-123';
    const BOUND_SESSION = 'session-in-a-room';

    /**
     * The server's authorizer, shaped like `authorizeBridgedApproval`: a
     * session no room owns is allowed outright, and a room-bound one needs the
     * allowlisted Telegram user. Every forgery below would PASS it — so a
     * refusal is the sender check's doing, not the authorizer's.
     */
    const serverShapedAuthorize: ApprovalAuthorizer = (d) =>
      d.sessionId === BOUND_SESSION
        ? d.platform === 'telegram' && d.respondedBy === '145223'
        : true;

    function forged(from: string, sessionId = OWN_SESSION, platform = 'telegram') {
      return createApprovalEnvelope({
        from,
        payload: {
          type: 'approval_response',
          toolCallId: OWN_TOOL_CALL,
          sessionId,
          approved: true,
          respondedBy: '145223',
          platform,
        },
      });
    }

    it.each([
      ['an agent', 'relay.agent.ns.agent-1'],
      ['a session', `relay.session.${OWN_SESSION}`],
      ['the external MCP surface', 'relay.external.mcp'],
      ['the in-app console', 'relay.human.console'],
      ['the old per-user adapter principal (any HTTP caller can assert it)', 'telegram:145223'],
      ['a different system principal', 'relay.system.tasks.scheduler'],
      ['an approval principal with no connection id', 'relay.system.approval-bridge.telegram'],
    ])('keeps an approval from %s pending on a session no room owns', (_who, from) => {
      const guard = vi.fn(serverShapedAuthorize);

      handleApprovalResponse(forged(from), [agentManager], log, guard, traceStore);

      expect(guard).not.toHaveBeenCalled();
      expect(agentManager.approveTool).not.toHaveBeenCalled();
    });

    it('keeps an agent’s approval pending on a room-bound session, even with an allowlisted user id', () => {
      const guard = vi.fn(serverShapedAuthorize);

      handleApprovalResponse(
        forged('relay.agent.ns.agent-1', BOUND_SESSION),
        [agentManager],
        log,
        guard,
        traceStore
      );

      expect(guard).not.toHaveBeenCalled();
      expect(agentManager.approveTool).not.toHaveBeenCalled();
    });

    it('records the refusal: one warning naming the sender, and a failed span', () => {
      handleApprovalResponse(
        forged('relay.agent.ns.agent-1'),
        [agentManager],
        log,
        authorize,
        traceStore
      );

      expect(log.warn).toHaveBeenCalledTimes(1);
      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('relay.agent.ns.agent-1'));
      expect(traceStore.insertSpan).toHaveBeenCalledOnce();
      expect(traceStore.insertSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId: 'approval-msg-001',
          subject: 'relay.system.approval.slack',
          fromEndpoint: 'relay.agent.ns.agent-1',
          status: 'failed',
          error: expect.stringContaining('relay.agent.ns.agent-1'),
        })
      );
    });

    it('refuses a bridge principal whose payload claims a different platform', () => {
      // The allowlist the authorizer consults is per platform, so the platform
      // it is handed must be the one the sender speaks for.
      handleApprovalResponse(
        forged(approvalBridgePrincipal('slack', 'slack-main'), BOUND_SESSION, 'telegram'),
        [agentManager],
        log,
        authorize,
        traceStore
      );

      expect(authorize).not.toHaveBeenCalled();
      expect(agentManager.approveTool).not.toHaveBeenCalled();
      expect(traceStore.insertSpan).toHaveBeenCalledOnce();
    });

    it('resolves a real Telegram click on a room-bound session', () => {
      handleApprovalResponse(
        forged(approvalBridgePrincipal('telegram', 'tg-main'), BOUND_SESSION),
        [agentManager],
        log,
        serverShapedAuthorize,
        traceStore
      );

      expect(agentManager.approveTool).toHaveBeenCalledWith(BOUND_SESSION, OWN_TOOL_CALL, true);
      expect(traceStore.insertSpan).not.toHaveBeenCalled();
    });

    it('resolves a real Telegram click on a session no room owns', () => {
      handleApprovalResponse(
        forged(approvalBridgePrincipal('telegram', 'tg-main')),
        [agentManager],
        log,
        serverShapedAuthorize,
        traceStore
      );

      expect(agentManager.approveTool).toHaveBeenCalledWith(OWN_SESSION, OWN_TOOL_CALL, true);
    });

    it('still asks the authorizer after the sender passes, so the room entitlement holds', () => {
      // A real bridge click from somebody off the room's allowlist.
      const envelope = forged(approvalBridgePrincipal('telegram', 'tg-main'), BOUND_SESSION);
      (envelope.payload as Record<string, unknown>).respondedBy = '999999';

      handleApprovalResponse(envelope, [agentManager], log, serverShapedAuthorize, traceStore);

      expect(agentManager.approveTool).not.toHaveBeenCalled();
    });
  });

  describe('subscribeApprovalHandler', () => {
    it('subscribes to relay.system.approval.> pattern', () => {
      subscribeApprovalHandler(relay, [agentManager], log, authorize, traceStore);

      expect(relay.subscribe).toHaveBeenCalledOnce();
      expect(relay.subscribe).toHaveBeenCalledWith(APPROVAL_SUBJECT_PATTERN, expect.any(Function));
    });

    it('returns an unsubscribe function', () => {
      const unsub = vi.fn();
      vi.mocked(relay.subscribe).mockReturnValue(unsub);

      const result = subscribeApprovalHandler(relay, [agentManager], log, authorize, traceStore);
      expect(result).toBe(unsub);
    });

    it('routes incoming envelopes to handleApprovalResponse via the callback', () => {
      subscribeApprovalHandler(relay, [agentManager], log, authorize, traceStore);

      const envelope = createApprovalEnvelope();
      relay.capturedHandler!(envelope);

      expect(agentManager.approveTool).toHaveBeenCalledWith('session-abc', 'tool-call-123', true);
    });
  });

  describe('handleApprovalResponse', () => {
    it('calls approveTool with correct args when approved', () => {
      const envelope = createApprovalEnvelope();
      handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

      expect(agentManager.approveTool).toHaveBeenCalledWith('session-abc', 'tool-call-123', true);
    });

    it('calls approveTool with approved=false for denial', () => {
      const envelope = createApprovalEnvelope({
        from: approvalBridgePrincipal('telegram', 'tg-main'),
        payload: {
          type: 'approval_response',
          toolCallId: 'tool-deny-456',
          sessionId: 'session-xyz',
          approved: false,
          respondedBy: 'U99999',
          platform: 'telegram',
        },
      });

      handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

      expect(agentManager.approveTool).toHaveBeenCalledWith('session-xyz', 'tool-deny-456', false);
    });

    it('logs debug message with approval details', () => {
      const envelope = createApprovalEnvelope();
      handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('approve'));
      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('tool-call-123'));
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

      handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('deny'));
    });

    it('warns when no runtime held the tool call', () => {
      vi.mocked(agentManager.approveTool).mockReturnValue(false);

      const envelope = createApprovalEnvelope();
      handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

      expect(log.warn).toHaveBeenCalledWith(
        expect.stringContaining('no runtime held this tool call')
      );
    });

    describe('malformed payloads', () => {
      it('does not crash when payload is null', () => {
        const envelope = createApprovalEnvelope({
          payload: null as unknown as Record<string, unknown>,
        });

        expect(() =>
          handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore)
        ).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('malformed payload'));
      });

      it('does not crash when payload has wrong type field', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'something_else', toolCallId: 'tc-1', sessionId: 's-1', approved: true },
        });

        expect(() =>
          handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore)
        ).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalled();
      });

      it('does not crash when toolCallId is missing', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'approval_response', sessionId: 's-1', approved: true },
        });

        expect(() =>
          handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore)
        ).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('does not crash when sessionId is missing', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'approval_response', toolCallId: 'tc-1', approved: true },
        });

        expect(() =>
          handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore)
        ).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('does not crash when approved is missing', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'approval_response', toolCallId: 'tc-1', sessionId: 's-1' },
        });

        expect(() =>
          handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore)
        ).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('does not crash when payload is a string', () => {
        const envelope = createApprovalEnvelope({
          payload: 'not an object' as unknown as Record<string, unknown>,
        });

        expect(() =>
          handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore)
        ).not.toThrow();
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });
    });

    describe('the server-side authorizer', () => {
      it('never reaches the runtime when the click is refused, and logs one line', () => {
        // Two independent gates: the adapter's own `mayApprove` ran in process
        // on the click, and this one runs before the runtime is touched. A
        // room-bound Ask reaches this bus by a path no adapter binding covers,
        // so the bus carries no authority of its own.
        authorize.mockReturnValue(false);
        const envelope = createApprovalEnvelope();

        handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

        expect(agentManager.approveTool).not.toHaveBeenCalled();
        expect(log.warn).toHaveBeenCalledTimes(1);
        expect(log.warn).toHaveBeenCalledWith(
          expect.stringContaining('refused an approval this caller may not give')
        );
      });

      it('forwards the decision when the click is authorized', () => {
        handleApprovalResponse(
          createApprovalEnvelope(),
          [agentManager],
          log,
          authorize,
          traceStore
        );

        expect(agentManager.approveTool).toHaveBeenCalledWith('session-abc', 'tool-call-123', true);
      });

      it('is handed the session, the platform and who clicked', () => {
        handleApprovalResponse(
          createApprovalEnvelope(),
          [agentManager],
          log,
          authorize,
          traceStore
        );

        expect(authorize).toHaveBeenCalledWith({
          sessionId: 'session-abc',
          platform: 'slack',
          respondedBy: 'U12345',
        });
      });

      it('reports an unidentified clicker as undefined rather than inventing one', () => {
        // `mayApprove` returns false for an unidentified caller, so the
        // authorizer has to be able to SEE that the platform named nobody.
        const envelope = createApprovalEnvelope({
          from: approvalBridgePrincipal('telegram', 'tg-main'),
          payload: {
            type: 'approval_response',
            toolCallId: 'tc-1',
            sessionId: 's-1',
            approved: true,
            platform: 'telegram',
          },
        });

        handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

        expect(authorize).toHaveBeenCalledWith({
          sessionId: 's-1',
          platform: 'telegram',
          respondedBy: undefined,
        });
      });

      it('is asked on every envelope the subscription routes, not only direct calls', () => {
        subscribeApprovalHandler(relay, [agentManager], log, authorize, traceStore);
        authorize.mockReturnValue(false);

        relay.capturedHandler!(createApprovalEnvelope());

        expect(authorize).toHaveBeenCalledTimes(1);
        expect(agentManager.approveTool).not.toHaveBeenCalled();
      });

      it('is not asked at all for a malformed payload', () => {
        const envelope = createApprovalEnvelope({
          payload: { type: 'something_else' },
        });

        handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

        expect(authorize).not.toHaveBeenCalled();
      });
    });

    it('takes the platform from the sender when the payload names none', () => {
      const envelope = createApprovalEnvelope({
        payload: {
          type: 'approval_response',
          toolCallId: 'tc-1',
          sessionId: 's-1',
          approved: true,
        },
      });

      handleApprovalResponse(envelope, [agentManager], log, authorize, traceStore);

      expect(log.debug).toHaveBeenCalledWith(expect.stringContaining('platform=slack'));
    });
  });

  describe('several runtimes (DOR-1614)', () => {
    // An approval card carries a session id and nothing else — no runtime — so
    // the decision is offered to each runtime in turn. Only one can hold a given
    // pending interaction, so this is exact rather than a guess.
    it('reaches the runtime that holds the interaction, not just the first one', () => {
      const first = createMockAgentManager();
      vi.mocked(first.approveTool).mockReturnValue(false);
      const second = createMockAgentManager();
      vi.mocked(second.approveTool).mockReturnValue(true);

      handleApprovalResponse(createApprovalEnvelope(), [first, second], log, authorize, traceStore);

      expect(second.approveTool).toHaveBeenCalledWith('session-abc', 'tool-call-123', true);
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('stops at the runtime that answers, so no bystander is asked', () => {
      const first = createMockAgentManager();
      const second = createMockAgentManager();

      handleApprovalResponse(createApprovalEnvelope(), [first, second], log, authorize, traceStore);

      expect(first.approveTool).toHaveBeenCalledOnce();
      expect(second.approveTool).not.toHaveBeenCalled();
    });

    it('names every runtime it asked when none held the tool call', () => {
      const first = createMockAgentManager('claude-code');
      vi.mocked(first.approveTool).mockReturnValue(false);
      const second = createMockAgentManager('codex');
      vi.mocked(second.approveTool).mockReturnValue(false);

      handleApprovalResponse(createApprovalEnvelope(), [first, second], log, authorize, traceStore);

      expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('claude-code, codex'));
    });

    it('touches no runtime at all when the gate refuses', () => {
      const first = createMockAgentManager();
      const second = createMockAgentManager();
      authorize.mockReturnValue(false);

      handleApprovalResponse(createApprovalEnvelope(), [first, second], log, authorize, traceStore);

      expect(first.approveTool).not.toHaveBeenCalled();
      expect(second.approveTool).not.toHaveBeenCalled();
    });
  });
});
