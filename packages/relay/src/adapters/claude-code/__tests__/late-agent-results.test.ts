/**
 * An agent's later report reaches the caller that asked for the work
 * (DOR-2717).
 *
 * A relay turn ends with its `agent_result`. Under a warm process the agent may
 * hand the work to a background helper, end that turn, and give the answer in
 * a turn it starts itself once the helper reports. The host tells the adapter
 * about those later turns through {@link LateTurnSource}; these pin what the
 * caller's inbox reads: the first result says more is coming, the later turn
 * arrives as a second result marked late, and a caller that cannot receive it —
 * a blocking wait — is never promised one.
 */
import { describe, it, expect, vi } from 'vitest';
import type { RelayEnvelope } from '@dorkos/shared/relay-schemas';
import { RelayAgentResultPayloadSchema } from '@dorkos/shared/relay-schemas';
import type { StreamEvent } from '@dorkos/shared/types';
import { ClaudeCodeAdapter } from '../index.js';
import type { AgentRuntimeLike, LateTurn, LateTurnSource } from '../index.js';
import type { RelayPublisher } from '../../../types.js';

/** A runtime whose one turn says `text` and ends; `holds` answers the work question. */
function runtimeSaying(text: string, holds: () => boolean): AgentRuntimeLike {
  return {
    ensureSession: vi.fn(),
    sendMessage: vi.fn().mockImplementation(() =>
      (async function* () {
        yield { type: 'text_delta', data: { text } } as StreamEvent;
        yield { type: 'done', data: {} } as StreamEvent;
      })()
    ),
    getSdkSessionId: vi.fn().mockReturnValue(undefined),
    approveTool: vi.fn().mockReturnValue(true),
    interruptQuery: vi.fn().mockResolvedValue(true),
    holdsBackgroundWork: vi.fn(holds),
  };
}

/** A late-turn source a test drives by hand. */
function handDrivenLateTurns(): LateTurnSource & {
  deliver: (turn: LateTurn) => void;
  follows: Array<{ runtimeType: string; sessionKey: string }>;
  stopped: number;
} {
  let onTurn: ((turn: LateTurn) => void) | undefined;
  const source = {
    follows: [] as Array<{ runtimeType: string; sessionKey: string }>,
    stopped: 0,
    follow(opts: { runtimeType: string; sessionKey: string; onTurn: (turn: LateTurn) => void }) {
      source.follows.push({ runtimeType: opts.runtimeType, sessionKey: opts.sessionKey });
      onTurn = opts.onTurn;
      return () => {
        source.stopped += 1;
      };
    },
    deliver(turn: LateTurn) {
      onTurn?.(turn);
    },
  };
  return source;
}

function createRelay(): RelayPublisher {
  return {
    publish: vi.fn().mockResolvedValue({ messageId: 'resp-1', deliveredTo: 1 }),
    onSignal: vi.fn().mockReturnValue(() => {}),
    subscribe: vi.fn().mockReturnValue(() => {}),
  };
}

function envelopeTo(replyTo: string): RelayEnvelope {
  return {
    id: 'msg-late-1',
    subject: 'relay.agent.session-late',
    from: 'relay.agent.caller',
    replyTo,
    budget: {
      hopCount: 1,
      maxHops: 5,
      ancestorChain: [],
      ttl: Date.now() + 300_000,
      callBudgetRemaining: 10,
    },
    createdAt: new Date().toISOString(),
    payload: { content: 'Is the build green?' },
  };
}

/** Every agent_result published to `subject`, in order. */
function resultsTo(relay: RelayPublisher, subject: string): Array<Record<string, unknown>> {
  return vi
    .mocked(relay.publish)
    .mock.calls.filter(
      ([to, payload]) => to === subject && (payload as { type?: string }).type === 'agent_result'
    )
    .map(([, payload]) => payload as Record<string, unknown>);
}

/** Let the detached late publishes settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

async function deliverOnce(opts: {
  replyTo: string;
  holds: () => boolean;
  lateTurns?: LateTurnSource;
}): Promise<{ relay: RelayPublisher; runtime: AgentRuntimeLike }> {
  const runtime = runtimeSaying('Started a helper; I will report back.', opts.holds);
  const relay = createRelay();
  const adapter = new ClaudeCodeAdapter(
    'claude-code',
    { defaultCwd: '/tmp' },
    {
      agentManager: runtime,
      traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
      approvalAuthorizer: () => true,
      ...(opts.lateTurns ? { lateTurns: opts.lateTurns } : {}),
    }
  );
  await adapter.start(relay);
  const envelope = envelopeTo(opts.replyTo);
  await adapter.deliver(envelope.subject, envelope);
  return { relay, runtime };
}

describe('a relay turn whose agent keeps working after it ends', () => {
  const inbox = 'relay.inbox.dispatch.late-1';

  it('says so on the first result, and delivers the later turn as a late result', async () => {
    let holding = true;
    const lateTurns = handDrivenLateTurns();
    const { relay } = await deliverOnce({ replyTo: inbox, holds: () => holding, lateTurns });

    const [first] = resultsTo(relay, inbox);
    expect(first).toMatchObject({
      type: 'agent_result',
      text: 'Started a helper; I will report back.',
      done: true,
      continuing: true,
    });
    expect(lateTurns.follows).toEqual([{ runtimeType: 'claude-code', sessionKey: 'session-late' }]);

    holding = false;
    lateTurns.deliver({ text: 'The build is green.', continuing: false });
    await flush();

    const results = resultsTo(relay, inbox);
    expect(results).toHaveLength(2);
    expect(results[1]).toEqual({
      type: 'agent_result',
      text: 'The build is green.',
      done: true,
      late: true,
    });
    // Both shapes are what the wire schema accepts.
    for (const result of results) expect(RelayAgentResultPayloadSchema.parse(result)).toBeTruthy();
  });

  it('marks a late result that is itself followed by more', async () => {
    const lateTurns = handDrivenLateTurns();
    const { relay } = await deliverOnce({ replyTo: inbox, holds: () => true, lateTurns });

    lateTurns.deliver({ text: 'Half done.', continuing: true });
    lateTurns.deliver({ text: 'Failed at the end.', error: 'tests failed', continuing: false });
    await flush();

    const results = resultsTo(relay, inbox);
    expect(results.slice(1)).toEqual([
      { type: 'agent_result', text: 'Half done.', done: true, late: true, continuing: true },
      {
        type: 'agent_result',
        text: 'Failed at the end.',
        done: true,
        late: true,
        error: 'tests failed',
      },
    ]);
  });

  it('promises nothing and follows nothing when the agent holds no work', async () => {
    const lateTurns = handDrivenLateTurns();
    const { relay } = await deliverOnce({ replyTo: inbox, holds: () => false, lateTurns });

    const [first] = resultsTo(relay, inbox);
    expect(first).toEqual({
      type: 'agent_result',
      text: 'Started a helper; I will report back.',
      done: true,
    });
    expect(lateTurns.follows).toEqual([]);
  });

  it('tells a blocking wait the agent is still working, without following for it', async () => {
    // `relay_send_and_wait` takes down its inbox the moment it has an answer,
    // so a late result could never arrive there. It is told, and nothing is
    // published into an inbox nobody is reading.
    const query = 'relay.inbox.query.late-1';
    const lateTurns = handDrivenLateTurns();
    const { relay } = await deliverOnce({ replyTo: query, holds: () => true, lateTurns });

    expect(resultsTo(relay, query)[0]).toMatchObject({ continuing: true });
    expect(lateTurns.follows).toEqual([]);
  });

  it('stops following when the next message to the same session starts', async () => {
    const lateTurns = handDrivenLateTurns();
    const runtime = runtimeSaying('Working on it.', () => true);
    const relay = createRelay();
    const adapter = new ClaudeCodeAdapter(
      'claude-code',
      { defaultCwd: '/tmp' },
      {
        agentManager: runtime,
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
        approvalAuthorizer: () => true,
        lateTurns,
      }
    );
    await adapter.start(relay);
    const first = envelopeTo(inbox);
    await adapter.deliver(first.subject, first);
    expect(lateTurns.stopped).toBe(0);

    const second = { ...envelopeTo('relay.inbox.dispatch.late-2'), id: 'msg-late-2' };
    await adapter.deliver(second.subject, second);

    // The first follower was stopped before the second turn began.
    expect(lateTurns.stopped).toBe(1);
    expect(lateTurns.follows).toHaveLength(2);
  });
});
