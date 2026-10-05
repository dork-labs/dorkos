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
import type { AgentRuntimeLike, LateFollowEnd, LateTurn, LateTurnSource } from '../index.js';
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

/** One follow the hand-driven source was asked for. */
interface HandFollow {
  runtimeType: string;
  sessionKey: string;
  sinceMark?: number;
  onTurn: (turn: LateTurn) => void;
  onEnd?: (reason: LateFollowEnd) => void;
  /** How the follow ended, once it has. */
  ended?: LateFollowEnd;
}

/**
 * A late-turn source a test drives by hand, keeping the host's contract: a
 * follow ends exactly once, and says why.
 */
function handDrivenLateTurns(): LateTurnSource & {
  follows: HandFollow[];
  /** Hand the newest follow a later turn; a non-continuing one ends it. */
  deliver: (turn: LateTurn) => void;
  /** End the newest follow from the host's side. */
  end: (reason: LateFollowEnd) => void;
  readonly stopped: number;
  /** Count a dispatched turn on the session, as the host does. */
  dispatched: () => void;
  /** Run once, the moment the mark is read — where a racing dispatch lands. */
  onMarkRead?: () => void;
} {
  const follows: HandFollow[] = [];
  let mark = 0;
  const finish = (follow: HandFollow, reason: LateFollowEnd): void => {
    if (follow.ended) return;
    follow.ended = reason;
    follow.onEnd?.(reason);
  };
  const source = {
    follows,
    onMarkRead: undefined as (() => void) | undefined,
    dispatched() {
      mark += 1;
    },
    dispatchMark() {
      const read = mark;
      source.onMarkRead?.();
      return read;
    },
    follow(opts: Omit<HandFollow, 'ended'>) {
      const follow: HandFollow = { ...opts };
      follows.push(follow);
      // The host's rule: work that reached the session since the mark ends the
      // follow at once.
      if (opts.sinceMark !== undefined && opts.sinceMark !== mark) finish(follow, 'superseded');
      return () => finish(follow, 'stopped');
    },
    deliver(turn: LateTurn) {
      const follow = follows.at(-1)!;
      if (follow.ended) return;
      follow.onTurn(turn);
      if (!turn.continuing) finish(follow, 'final');
    },
    end(reason: LateFollowEnd) {
      finish(follows.at(-1)!, reason);
    },
    get stopped() {
      return follows.filter((f) => f.ended === 'stopped').length;
    },
  };
  return source;
}

/** The result that closes a follow which ended without a final report. */
function nothingMore(ended: 'expired' | 'superseded' | 'stopped'): Record<string, unknown> {
  return { type: 'agent_result', text: '', done: true, late: true, ended };
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
}): Promise<{ relay: RelayPublisher; runtime: AgentRuntimeLike; adapter: ClaudeCodeAdapter }> {
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
  return { relay, runtime, adapter };
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
    expect(lateTurns.follows.map((f) => [f.runtimeType, f.sessionKey])).toEqual([
      ['claude-code', 'session-late'],
    ]);

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

  it('ends the earlier follow when the next message reaches the same conversation, renamed or not', async () => {
    // The first turn persists the runtime's own id for the conversation, so the
    // second turn runs under a different key than the first did. The follow is
    // still the same conversation's, and the second message still ends it.
    const lateTurns = handDrivenLateTurns();
    const runtime = runtimeSaying('Working on it.', () => true);
    vi.mocked(runtime.getSdkSessionId!).mockReturnValue('sdk-session-1');
    const mappings = new Map<string, string>();
    const relay = createRelay();
    const adapter = new ClaudeCodeAdapter(
      'claude-code',
      { defaultCwd: '/tmp' },
      {
        agentManager: runtime,
        traceStore: { insertSpan: vi.fn(), updateSpan: vi.fn() },
        approvalAuthorizer: () => true,
        agentSessionStore: {
          get: (key) => mappings.get(key),
          set: (key, value) => void mappings.set(key, value),
        },
        lateTurns,
      }
    );
    await adapter.start(relay);
    const first = envelopeTo(inbox);
    await adapter.deliver(first.subject, first);
    expect(mappings.size).toBe(1);
    expect(lateTurns.follows[0]!.ended).toBeUndefined();

    const secondInbox = 'relay.inbox.dispatch.late-2';
    const second = { ...envelopeTo(secondInbox), id: 'msg-late-2' };
    await adapter.deliver(second.subject, second);
    await flush();

    expect(vi.mocked(runtime.sendMessage).mock.calls[1]![0]).toBe('sdk-session-1');
    expect(lateTurns.follows[0]!.ended).toBe('stopped');
    // And the first caller is told nothing more is coming, not left polling.
    expect(resultsTo(relay, inbox).at(-1)).toEqual(nothingMore('stopped'));
    // A later turn now belongs to the second caller alone.
    lateTurns.deliver({ text: 'The build is green.', continuing: false });
    await flush();
    expect(resultsTo(relay, inbox).map((r) => r.text)).not.toContain('The build is green.');
    expect(resultsTo(relay, secondInbox).at(-1)).toMatchObject({ text: 'The build is green.' });
  });

  describe('a promise of more is never left hanging', () => {
    it.each(['expired', 'superseded'] as const)(
      'closes the inbox`s wait when the host ends the follow as %s',
      async (reason) => {
        const lateTurns = handDrivenLateTurns();
        const { relay } = await deliverOnce({ replyTo: inbox, holds: () => true, lateTurns });

        lateTurns.end(reason);
        await flush();

        expect(resultsTo(relay, inbox).at(-1)).toEqual(nothingMore(reason));
        // `error` stays the turn-failed signal; the closing result is not a failure.
        expect(resultsTo(relay, inbox).at(-1)).not.toHaveProperty('error');
        expect(RelayAgentResultPayloadSchema.parse(nothingMore(reason))).toBeTruthy();
      }
    );

    it('closes it when the adapter stops', async () => {
      const lateTurns = handDrivenLateTurns();
      const { relay, adapter } = await deliverOnce({
        replyTo: inbox,
        holds: () => true,
        lateTurns,
      });

      await adapter.stop();
      await flush();

      expect(lateTurns.follows[0]!.ended).toBe('stopped');
      expect(resultsTo(relay, inbox).at(-1)).toEqual(nothingMore('stopped'));
    });

    it('adds nothing after a final report', async () => {
      const lateTurns = handDrivenLateTurns();
      const { relay } = await deliverOnce({ replyTo: inbox, holds: () => true, lateTurns });

      lateTurns.deliver({ text: 'Done.', continuing: false });
      await flush();

      expect(resultsTo(relay, inbox).map((r) => r.text)).toEqual([
        'Started a helper; I will report back.',
        'Done.',
      ]);
    });
  });

  it('ends the follow at once when somebody dispatched into the session while its result was going out', async () => {
    // The race: the relay turn ends, and before the follow is registered — while
    // the first result is still being published — a person sends their own
    // message. The follow must not outlive that, or their helper's report would
    // reach this caller.
    const lateTurns = handDrivenLateTurns();
    lateTurns.onMarkRead = () => lateTurns.dispatched();
    const { relay } = await deliverOnce({ replyTo: inbox, holds: () => true, lateTurns });
    await flush();

    expect(lateTurns.follows[0]!.sinceMark).toBe(0);
    expect(lateTurns.follows[0]!.ended).toBe('superseded');
    expect(resultsTo(relay, inbox).at(-1)).toEqual(nothingMore('superseded'));
  });
});
