/**
 * A beat's triage on the decision ladder (spec `heartbeats` §6.2, §10 PR 5):
 * the verdict mapping, unsure going up to a turn, the money/customers/security
 * rule, and the daily fuse. Rung 1 is the real OpenAI-compatible bridge over a
 * fake server; nothing reaches the network.
 */
import { describe, expect, it } from 'vitest';
import {
  createMemoryCallCounter,
  createOpenAiCompatibleModel,
  type DailyCallCounter,
} from '@dorkos/decisions';
import {
  TRIAGE_FUSE,
  TRIAGE_USE_CASE,
  triageBeat,
  triageBeatWith,
  type TriageBeatContext,
} from '../heartbeat-triage.js';
import { COMMITS, MONEY, fakeChatServer, type FakeAnswer } from './triage-fakes.js';

const NOW = Date.parse('2026-10-12T14:00:00Z');
const UNDECIDED: TriageBeatContext = { agentName: 'Juno', checklist: null, rules: 'undecided' };

/** Triage with a credits bridge over a fake server answering `answer`. */
async function withModel(
  answer: FakeAnswer | ((n: number) => FakeAnswer),
  changes = [COMMITS],
  counter: DailyCallCounter = createMemoryCallCounter()
) {
  const server = fakeChatServer(answer);
  const model = createOpenAiCompatibleModel({
    baseUrl: 'http://credits.test/v1',
    model: 'small-1',
    fetch: server.fetch,
    circuitBreaker: false,
  });
  const outcome = await triageBeatWith(
    { creditsModel: async () => ({ model, requests: () => 1 }), counter, now: () => NOW },
    changes,
    UNDECIDED
  );
  return { outcome, server };
}

describe('the verdict mapping', () => {
  it('a1 is quiet, c3 joins the report queue, b2 is a turn', async () => {
    expect((await withModel({ label: 'a1', probability: 0.95 })).outcome.decision).toBe('quiet');
    expect((await withModel({ label: 'c3', probability: 0.95 })).outcome.decision).toBe('queue');
    expect((await withModel({ label: 'b2', probability: 0.95 })).outcome.decision).toBe('turn');
  });

  it('lets the rules settle what they can without asking a model', async () => {
    const server = fakeChatServer({ label: 'a1', probability: 0.99 });
    let asked = 0;
    const deps = {
      creditsModel: async () => {
        asked += 1;
        const model = createOpenAiCompatibleModel({
          baseUrl: 'http://credits.test/v1',
          model: 'small-1',
          fetch: server.fetch,
        });
        return { model, requests: () => 0 };
      },
      counter: createMemoryCallCounter(),
    };
    const work = await triageBeatWith(deps, [COMMITS], { ...UNDECIDED, rules: 'work' });
    const quiet = await triageBeatWith(deps, [COMMITS], { ...UNDECIDED, rules: 'quiet' });
    expect(work.decision).toBe('turn');
    expect(quiet.decision).toBe('quiet');
    expect(asked).toBe(0);
    expect(server.seen).toHaveLength(0);
  });

  it('records every rung’s model, answer, confidence and usage', async () => {
    const { outcome } = await withModel({ label: 'c3', probability: 0.95 });
    expect(outcome.source).toBe('credits');
    expect(outcome.steps).toEqual([
      { rung: 0, model: 'rules:heartbeat.triage', answer: null, confidence: 0 },
      {
        rung: 1,
        model: 'small-1',
        answer: 'c3',
        confidence: expect.closeTo(0.95, 6),
        probability: expect.closeTo(0.95, 6),
        usage: { inputTokens: 120, outputTokens: 6 },
        requests: 1,
      },
    ]);
  });

  it('asks one choice question with neutral labels, the changes as data', async () => {
    const { server } = await withModel({ label: 'a1', probability: 0.95 });
    const schema = (server.seen[0]!.body.response_format as { json_schema: { schema: unknown } })
      .json_schema.schema as { properties: Record<string, { enum: string[] }> };
    expect(schema.properties).toEqual({ triage: { type: 'string', enum: ['a1', 'b2', 'c3'] } });
    // The changes travel as data in their own message, never in the rules.
    const messages = server.seen[0]!.body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]!.content).not.toContain('Ana');
    expect(messages[1]!.content).toContain('3 new commits on main by Ana.');
  });
});

describe('unsure goes up to a turn, never down to silence', () => {
  it('review (a lean that is not sure enough) is a turn', async () => {
    const { outcome } = await withModel({ label: 'a1', probability: 0.6 });
    expect(outcome.decision).toBe('turn');
  });

  it('a model that is unsure, fails or is unreachable is a turn', async () => {
    expect((await withModel({ label: 'a1', probability: 0.3 })).outcome.decision).toBe('turn');
    expect((await withModel({ label: 'a1', status: 503 })).outcome.decision).toBe('turn');
  });

  it('with no credits bridge, what the rules cannot settle is a turn', async () => {
    const outcome = await triageBeatWith(
      { creditsModel: async () => undefined, counter: createMemoryCallCounter() },
      [COMMITS],
      UNDECIDED
    );
    expect(outcome).toMatchObject({ decision: 'turn', source: 'runtime' });
  });

  it('before startup wires it, triageBeat runs the rules alone', async () => {
    expect((await triageBeat([COMMITS], UNDECIDED)).decision).toBe('turn');
    expect((await triageBeat([COMMITS], { ...UNDECIDED, rules: 'quiet' })).decision).toBe('quiet');
  });
});

describe('money, customers and security', () => {
  it('are never dismissed by an ask-twice confidence, however much the asks agree', async () => {
    const { outcome, server } = await withModel({ label: 'a1' }, [MONEY]);
    // No logprobs, so the bridge asked twice and the answers agreed: act.
    expect(server.seen).toHaveLength(2);
    expect(outcome.decision).toBe('turn');
  });

  it('need the dismissal’s own probability at 0.9 or more', async () => {
    expect((await withModel({ label: 'c3', probability: 0.85 }, [MONEY])).outcome.decision).toBe(
      'turn'
    );
    expect((await withModel({ label: 'a1', probability: 0.89 }, [MONEY])).outcome.decision).toBe(
      'turn'
    );
    expect((await withModel({ label: 'c3', probability: 0.92 }, [MONEY])).outcome.decision).toBe(
      'queue'
    );
  });

  it('a change with nothing serious is dismissed at an ordinary confident answer', async () => {
    expect((await withModel({ label: 'a1' })).outcome.decision).toBe('quiet');
  });
});

describe('the daily fuse', () => {
  it('past 2,000 rung-1 calls today, the ladder is unsure and a turn decides', async () => {
    const counter = createMemoryCallCounter();
    for (let i = 0; i < TRIAGE_FUSE; i += 1) counter.increment(TRIAGE_USE_CASE, 1, '2026-10-12');
    const { outcome, server } = await withModel(
      { label: 'a1', probability: 0.99 },
      [COMMITS],
      counter
    );
    expect(server.seen).toHaveLength(0);
    expect(outcome.decision).toBe('turn');
    expect(outcome.steps.at(-1)).toMatchObject({ rung: 1, skipped: 'fuse' });
  });

  it('counts each rung-1 call once, by UTC day', async () => {
    const counter = createMemoryCallCounter();
    await withModel({ label: 'a1', probability: 0.99 }, [COMMITS], counter);
    await withModel({ label: 'a1', probability: 0.99 }, [COMMITS], counter);
    expect(counter.count(TRIAGE_USE_CASE, 1, '2026-10-12')).toBe(2);
  });
});
