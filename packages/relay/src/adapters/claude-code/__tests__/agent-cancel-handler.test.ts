import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { AGENT_CANCEL_SUBJECT_PREFIX, A2A_GATEWAY_PRINCIPAL } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type { AgentRuntimeLike, ClaudeCodeAdapterDeps, TraceStoreLike } from '../index.js';
import type { MessageHandler, RelayPublisher } from '../../../types.js';
import { handleAgentCancel, AGENT_CANCEL_SUBJECT_PATTERN } from '../agent-cancel-handler.js';
import { AbortRegistry } from '../../../lib/abort-registry.js';

/** The reply subject the A2A gateway mints per execution — what names a turn. */
const REPLY_TO = 'relay.a2a.reply.task-1.b0b0';

const silentLog = { warn: vi.fn(), debug: vi.fn() };

function cancelEnvelope(replyTo = REPLY_TO, payload?: unknown): RelayEnvelope {
  return {
    id: 'msg-cancel-1',
    subject: `${AGENT_CANCEL_SUBJECT_PREFIX}task-1`,
    from: A2A_GATEWAY_PRINCIPAL,
    budget: {
      hopCount: 0,
      maxHops: 1,
      ancestorChain: [],
      ttl: Date.now() + 30_000,
      callBudgetRemaining: 1,
    },
    createdAt: new Date().toISOString(),
    payload: payload ?? { type: 'agent_cancel', replyTo, reason: 'caller_canceled' },
  };
}

describe('handleAgentCancel', () => {
  it('stops a turn this adapter is executing', () => {
    const running = new AbortRegistry();
    const controller = new AbortController();
    running.register(REPLY_TO, controller);

    const verdict = handleAgentCancel(cancelEnvelope(), running, silentLog);

    expect(verdict).toBeUndefined();
    expect(controller.signal.aborted).toBe(true);
    // The reason travels with the abort: a cancel must not be reported as a
    // budget expiry further down.
    expect(controller.signal.reason).toEqual({
      kind: 'caller-cancel',
      reason: 'caller_canceled',
    });
  });

  it('refuses — without throwing — for a turn nobody here is executing', () => {
    const running = new AbortRegistry();

    const verdict = handleAgentCancel(cancelEnvelope(), running, silentLog);

    // A refusal, not a silent success: it is what makes the publisher's
    // deliveredTo an honest answer to "did anything take this?", which is what
    // the gateway reports to its A2A caller.
    expect(verdict).toEqual({ handled: false, reason: expect.stringContaining(REPLY_TO) });
  });

  it('refuses a stop from anyone but the gateway, without touching the turn', () => {
    const running = new AbortRegistry();
    const controller = new AbortController();
    running.register(REPLY_TO, controller);

    const verdict = handleAgentCancel(
      { ...cancelEnvelope(), from: 'relay.agent.default.some-other-agent' },
      running,
      silentLog
    );

    expect(verdict).toEqual({ handled: false, reason: expect.stringContaining('gateway') });
    expect(controller.signal.aborted).toBe(false);
  });

  it('refuses a payload that is not a stop request', () => {
    const running = new AbortRegistry();

    const verdict = handleAgentCancel(
      cancelEnvelope(REPLY_TO, { type: 'something_else' }),
      running,
      silentLog
    );

    expect(verdict).toEqual({ handled: false, reason: expect.any(String) });
  });

  it('is idempotent — a second stop changes nothing', () => {
    const running = new AbortRegistry();
    const controller = new AbortController();
    running.register(REPLY_TO, controller);

    handleAgentCancel(cancelEnvelope(), running, silentLog);
    const reason = controller.signal.reason;
    const second = handleAgentCancel(cancelEnvelope(), running, silentLog);

    expect(second).toBeUndefined();
    expect(controller.signal.reason).toBe(reason);
  });
});

/**
 * A turn that parks after one event and ends only when the runtime is
 * interrupted — which is what a real runtime does, and the reason a stop has to
 * reach `interruptQuery` rather than merely abandoning the stream.
 */
function parkedTurn(): {
  stream: AsyncGenerator<StreamEvent>;
  parked: Promise<void>;
  end: () => void;
} {
  let signalParked!: () => void;
  let end!: () => void;
  const parked = new Promise<void>((resolve) => {
    signalParked = resolve;
  });
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const stream = (async function* () {
    yield { type: 'text_delta', data: { text: 'thinking' } } as StreamEvent;
    signalParked();
    await ended;
  })();
  return { stream, parked, end };
}

function agentEnvelope(overrides?: Partial<RelayEnvelope>): RelayEnvelope {
  return {
    id: 'msg-agent-1',
    subject: 'relay.agent.default.agent-01',
    from: 'a2a-gateway',
    replyTo: REPLY_TO,
    budget: {
      hopCount: 0,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 5,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'Run the tests.', senderName: 'a2a-client', channelType: 'dm' },
    ...overrides,
  };
}

describe('ClaudeCodeAdapter — stopping an agent turn', () => {
  let agentManager: AgentRuntimeLike;
  let traceStore: TraceStoreLike;
  let relay: RelayPublisher;
  let adapter: ClaudeCodeAdapter;
  let turn: ReturnType<typeof parkedTurn>;

  /** The handler the adapter registered for turn stop requests. */
  function cancelHandler(): MessageHandler {
    const call = vi
      .mocked(relay.subscribe)
      .mock.calls.find(([pattern]) => pattern === AGENT_CANCEL_SUBJECT_PATTERN);
    if (!call) throw new Error('adapter never subscribed to turn stop requests');
    return call[1];
  }

  /** Every StreamEvent the adapter published back to the reply subject. */
  function repliedEvents(): Array<{ type: string; data?: { message?: string } }> {
    return vi
      .mocked(relay.publish)
      .mock.calls.filter(([subject]) => subject === REPLY_TO)
      .map(([, payload]) => payload as { type: string; data?: { message?: string } });
  }

  beforeEach(() => {
    turn = parkedTurn();
    agentManager = {
      ensureSession: vi.fn(),
      sendMessage: vi.fn().mockReturnValue(turn.stream),
      getSdkSessionId: vi.fn().mockReturnValue(undefined),
      approveTool: vi.fn().mockReturnValue(true),
      // A real runtime ends the query it was told to interrupt. Modelling that
      // is what makes this test about the WHOLE path rather than one call.
      interruptQuery: vi.fn(async () => {
        turn.end();
        return true;
      }),
    };
    traceStore = { insertSpan: vi.fn(), updateSpan: vi.fn() };
    relay = {
      publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
      onSignal: vi.fn().mockReturnValue(() => {}),
      subscribe: vi.fn().mockReturnValue(() => {}),
    };
    const deps: ClaudeCodeAdapterDeps = {
      agentManager,
      traceStore,
      approvalAuthorizer: () => true,
    };
    adapter = new ClaudeCodeAdapter('claude-code', { defaultCwd: '/default/cwd' }, deps);
  });

  it('ends the turn at the runtime, not just at the stream', async () => {
    await adapter.start(relay);
    const envelope = agentEnvelope();
    const delivery = adapter.deliver(envelope.subject, envelope);
    await turn.parked;

    const verdict = await cancelHandler()(cancelEnvelope());
    await delivery;

    expect(verdict).toBeUndefined();
    // Abandoning the stream leaves the model running and billing; this is the
    // only call that actually stops it (DOR-791).
    expect(agentManager.interruptQuery).toHaveBeenCalledWith('agent-01');
  });

  it('tells the reply stream a caller stopped it, not that a budget expired', async () => {
    await adapter.start(relay);
    const envelope = agentEnvelope();
    const delivery = adapter.deliver(envelope.subject, envelope);
    await turn.parked;

    await cancelHandler()(cancelEnvelope());
    await delivery;

    const error = repliedEvents().find((e) => e.type === 'error');
    expect(error?.data?.message).toContain('cancelled');
    expect(error?.data?.message).not.toContain('TTL');
    // The terminal `done` still goes out, so the reply consumer settles.
    expect(repliedEvents().some((e) => e.type === 'done')).toBe(true);
  });

  it('reaches a turn even when every concurrency slot is taken', async () => {
    // The whole reason a stop travels by subscription: deliver() holds a slot
    // for the turn's entire life, so a stop routed through it would queue
    // behind the very turn it is trying to end.
    const single = new ClaudeCodeAdapter(
      'claude-code',
      { defaultCwd: '/default/cwd', maxConcurrent: 1 },
      { agentManager, traceStore, approvalAuthorizer: () => true }
    );
    await single.start(relay);
    const envelope = agentEnvelope();
    const delivery = single.deliver(envelope.subject, envelope);
    await turn.parked;

    await cancelHandler()(cancelEnvelope());
    await delivery;

    expect(agentManager.interruptQuery).toHaveBeenCalledWith('agent-01');
  });

  it('stops a turn still queued behind another on the same session — and never starts it', async () => {
    // The adapter runs one turn per session key at a time, so a second turn on
    // the same agent sits in a queue. Registering it only at the head of that
    // queue meant a cancel was refused as "not executing here" and the turn
    // then ran, and billed, after the caller had been told it could not be
    // canceled (DOR-791).
    await adapter.start(relay);
    const second = parkedTurn();
    vi.mocked(agentManager.sendMessage)
      .mockReturnValueOnce(turn.stream)
      .mockReturnValueOnce(second.stream);

    const queuedReplyTo = 'relay.a2a.reply.task-1.c1c1';
    const first = agentEnvelope();
    const queued = agentEnvelope({ id: 'msg-agent-2', replyTo: queuedReplyTo });
    const firstDelivery = adapter.deliver(first.subject, first);
    const queuedDelivery = adapter.deliver(queued.subject, queued);
    await turn.parked;

    // The queued turn is cancelable while it waits.
    const verdict = await cancelHandler()(cancelEnvelope(queuedReplyTo));
    expect(verdict).toBeUndefined();

    // Let the first turn finish so the queue advances to the canceled one.
    turn.end();
    await firstDelivery;
    const result = await queuedDelivery;

    // It never started: one turn ran, not two. `sendMessage` is what starts —
    // and bills — a turn.
    expect(agentManager.sendMessage).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    // And its caller's reply stream still settles rather than hanging.
    const queuedReplies = vi
      .mocked(relay.publish)
      .mock.calls.filter(([subject]) => subject === queuedReplyTo)
      .map(([, payload]) => payload as { type: string; data?: { message?: string } });
    expect(queuedReplies.some((e) => e.type === 'done')).toBe(true);
    expect(queuedReplies.find((e) => e.type === 'error')?.data?.message).toContain('cancelled');
  });

  it('refuses a stop for a turn that already finished, and interrupts nothing', async () => {
    await adapter.start(relay);
    vi.mocked(agentManager.sendMessage).mockReturnValue(
      (async function* () {
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    );
    const envelope = agentEnvelope();

    await adapter.deliver(envelope.subject, envelope);
    const verdict = await cancelHandler()(cancelEnvelope());

    expect(verdict).toEqual({ handled: false, reason: expect.stringContaining(REPLY_TO) });
    expect(agentManager.interruptQuery).not.toHaveBeenCalled();
  });

  it('refuses a stop after the adapter restarts — it no longer knows the turn', async () => {
    await adapter.start(relay);
    const envelope = agentEnvelope();
    const delivery = adapter.deliver(envelope.subject, envelope);
    await turn.parked;
    const handler = cancelHandler();

    await adapter.stop();

    // The registry does not survive the restart. Saying "stopped" here would
    // be a guess, and the gateway would pass that guess on as a fact.
    expect(await handler(cancelEnvelope())).toEqual({
      handled: false,
      reason: expect.stringContaining(REPLY_TO),
    });

    turn.end();
    await delivery;
  });
});
