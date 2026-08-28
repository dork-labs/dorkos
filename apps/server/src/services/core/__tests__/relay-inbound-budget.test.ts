/**
 * DOR-791: a turn the message bus started sends on the budget of the envelope
 * that started it, not on a fresh one the model may or may not have asked for.
 *
 * The association is made server-side — the dispatching adapter binds the
 * envelope to the session key, the tool handler reads it back — so these drive
 * the tool handlers with a bound registry rather than with a budget argument.
 */
import { describe, it, expect, vi } from 'vitest';
import { InboundTurnBudgets } from '@dorkos/relay';
import {
  createRelaySendHandler,
  createRelayDispatchHandler,
  createRelayQueryHandler,
  type McpToolDeps,
} from '../../runtimes/claude-code/mcp-tools/index.js';
import {
  resolveOutboundBudget,
  type SenderIdentity,
} from '../../runtimes/claude-code/mcp-tools/relay-helpers.js';
import type { RelayBudget } from '@dorkos/shared/relay-schemas';

const SENDER: SenderIdentity = { subject: 'relay.agent.sender', agentId: 'sender' };

/** The budget a turn inherits: one hop in, nine calls left, an hour to live. */
function inbound(overrides: Partial<RelayBudget> = {}): RelayBudget {
  return {
    hopCount: 1,
    maxHops: 5,
    ancestorChain: ['relay.agent.sender'],
    ttl: 2_000_000_000_000,
    callBudgetRemaining: 9,
    ...overrides,
  };
}

function makeDeps(publish: ReturnType<typeof vi.fn>): McpToolDeps {
  return {
    transcriptReader: {} as McpToolDeps['transcriptReader'],
    defaultCwd: '/test',
    notifyBudget: {} as McpToolDeps['notifyBudget'],
    dorkHome: '/test/.dork',
    relayCore: {
      publish,
      // `relay_send_and_wait` subscribes to its reply inbox BEFORE it publishes,
      // so the double needs one even for the paths that never wait.
      subscribe: vi.fn().mockReturnValue(() => undefined),
      registerEndpoint: vi.fn().mockResolvedValue({ subject: 'relay.inbox.new', hash: 'h' }),
      unregisterEndpoint: vi.fn().mockResolvedValue(true),
      getDispatchInboxTtlMs: vi.fn().mockReturnValue(30 * 60 * 1000),
    } as unknown as McpToolDeps['relayCore'],
  };
}

describe('relay_send inside a bus-triggered turn (DOR-791)', () => {
  it('publishes on the INHERITED budget when the model passes none', async () => {
    const publish = vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 });
    const budgets = new InboundTurnBudgets();
    budgets.bind('session-1', inbound());

    const send = createRelaySendHandler(makeDeps(publish), SENDER, () => budgets.get('session-1'));
    await send({ subject: 'relay.agent.peer', payload: { text: 'hi back' } });

    const [, , options] = publish.mock.calls[0] as [string, unknown, { budget?: RelayBudget }];
    expect(options.budget).toEqual({
      hopCount: 1,
      maxHops: 5,
      ttl: 2_000_000_000_000,
      callBudgetRemaining: 9,
    });
  });

  it('mints nothing to inherit for a turn a person started — the old behaviour, unchanged', async () => {
    const publish = vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 });
    const budgets = new InboundTurnBudgets();

    const send = createRelaySendHandler(makeDeps(publish), SENDER, () =>
      budgets.get('session-with-nothing-bound')
    );
    await send({ subject: 'relay.agent.peer', payload: { text: 'hello' } });

    const [, , options] = publish.mock.calls[0] as [string, unknown, { budget?: RelayBudget }];
    expect(options.budget).toBeUndefined();
  });

  it('threads the same inheritance through the async dispatch tool', async () => {
    const publish = vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 });
    const budgets = new InboundTurnBudgets();
    budgets.bind('session-1', inbound({ callBudgetRemaining: 2 }));

    const dispatch = createRelayDispatchHandler(makeDeps(publish), SENDER, () =>
      budgets.get('session-1')
    );
    await dispatch({ to_subject: 'relay.agent.peer', payload: { text: 'async' } });

    const [, , options] = publish.mock.calls[0] as [string, unknown, { budget?: RelayBudget }];
    expect(options.budget?.callBudgetRemaining).toBe(2);
  });
});

describe('resolveOutboundBudget', () => {
  it('lets a declared budget SHRINK an inherited one', () => {
    expect(
      resolveOutboundBudget(inbound(), { maxHops: 2, callBudgetRemaining: 1, ttl: 1_000 })
    ).toEqual({ hopCount: 1, maxHops: 2, callBudgetRemaining: 1, ttl: 1_000 });
  });

  it('refuses to let a declared budget RAISE an inherited one', () => {
    // A bound the bounded party can raise is not a bound: an agent that asks
    // for a thousand hops gets the five it was given.
    expect(
      resolveOutboundBudget(inbound(), {
        maxHops: 1_000,
        callBudgetRemaining: 1_000,
        ttl: 9_000_000_000_000,
      })
    ).toEqual({ hopCount: 1, maxHops: 5, callBudgetRemaining: 9, ttl: 2_000_000_000_000 });
  });

  it('does not carry the ancestor chain, so a peer may answer back at all', () => {
    // Carrying it would hand the publish gate a chain containing the peer that
    // just wrote, and the first reply back would be refused as a cycle — every
    // agent-to-agent exchange exactly two messages long. What bounds the chain
    // is the hop ceiling, the call budget, the TTL, and the hourly turn ceiling.
    const resolved = resolveOutboundBudget(inbound(), undefined);
    expect(resolved).not.toHaveProperty('ancestorChain');
  });

  it('passes a declared budget straight through when nothing is inherited', () => {
    expect(resolveOutboundBudget(undefined, { maxHops: 3 })).toEqual({ maxHops: 3 });
    expect(resolveOutboundBudget(undefined, undefined)).toBeUndefined();
  });
});

describe('relay_send reports a ceiling refusal the mailbox copy would hide (DOR-791)', () => {
  it('is an error, not a success, when a turn was refused but a copy landed', async () => {
    // The ceiling refuses the TURN, not the message, so `deliveredTo` is 1 and
    // the plain rejected-with-no-delivery check waves it through. The caller who
    // most needs to hear "nobody is going to answer" is an agent in an
    // accidental loop — exactly the caller a `deliveredTo: 1` teaches to retry.
    const publish = vi.fn().mockResolvedValue({
      messageId: 'm1',
      deliveredTo: 1,
      rejected: [{ endpointHash: 'relay.agent.peer', reason: 'turn_ceiling' }],
    });

    const send = createRelaySendHandler(makeDeps(publish), SENDER);
    const result = (await send({ subject: 'relay.agent.peer', payload: { text: 'hi' } })) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    const body = JSON.parse(result.content[0]!.text) as { code: string; error: string };
    expect(body.code).toBe('TURN_CEILING');
    expect(body.error).toContain('hourly limit');
  });

  it('still reports a plain delivery as a success', async () => {
    const publish = vi.fn().mockResolvedValue({ messageId: 'm1', deliveredTo: 1 });
    const send = createRelaySendHandler(makeDeps(publish), SENDER);
    const result = (await send({ subject: 'relay.agent.peer', payload: { text: 'hi' } })) as {
      isError?: boolean;
    };
    expect(result.isError).toBeFalsy();
  });
});

describe('every send tool reports a ceiling refusal the mailbox copy would hide (DOR-791)', () => {
  /** A publish that delivered to the mailbox but had its turn refused. */
  const refusedButDelivered = {
    messageId: 'm1',
    deliveredTo: 1,
    rejected: [{ endpointHash: 'relay.agent.peer', reason: 'turn_ceiling' }],
  };

  /**
   * Read a tool result's JSON body.
   *
   * @param result - What the handler returned.
   */
  function body(result: unknown): { code?: string; error?: string } {
    const typed = result as { content: { text: string }[] };
    return JSON.parse(typed.content[0]!.text) as { code?: string; error?: string };
  }

  it('relay_send_and_wait answers at once instead of waiting out its timeout', async () => {
    // Waiting would burn the caller's whole timeout for an answer no turn is
    // being run to produce.
    const publish = vi.fn().mockResolvedValue(refusedButDelivered);
    const query = createRelayQueryHandler(makeDeps(publish), SENDER);

    const result = (await query({
      to_subject: 'relay.agent.peer',
      payload: { text: 'hi' },
      timeout_ms: 60_000,
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(body(result).code).toBe('TURN_CEILING');
  });

  it('relay_send_async refuses rather than handing back an inbox nothing will fill', async () => {
    const publish = vi.fn().mockResolvedValue(refusedButDelivered);
    const deps = makeDeps(publish);
    const dispatch = createRelayDispatchHandler(deps, SENDER);

    const result = (await dispatch({
      to_subject: 'relay.agent.peer',
      payload: { text: 'hi' },
    })) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(body(result).code).toBe('TURN_CEILING');
    // The inbox it registered a moment ago is cleaned up, not leaked.
    expect(deps.relayCore!.unregisterEndpoint).toHaveBeenCalled();
  });
});
