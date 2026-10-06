/**
 * Summarizing a Codex conversation on the app-server transport (DOR-2732):
 * `thread/compact/start`, which 0.154 runs as a turn of its own. Over the fake
 * app-server, scripted from what the real binary sent (`turn/started`, a
 * `contextCompaction` item, a usage reading with the post-summary size,
 * `turn/completed`; no `thread/compacted`).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { StreamEvent } from '@dorkos/shared/types';
import { StreamEventSchema } from '@dorkos/shared/schemas';
import { makeAppServerHarness, PERSON_HOME } from '../../__tests__/app-server-harness.js';
import type { BackgroundWake } from '../background-work.js';
import {
  COMPACTED_TOKENS,
  backgroundCommandTurn,
  failedCompactionTurn,
  parkedCompactionTurn,
} from '../../__tests__/fake-app-server.js';
import {
  CONVERSATION_GONE_COPY,
  COMPACTION_NOT_STARTED_COPY,
  NOTHING_TO_SUMMARIZE_COPY,
} from '../../transport/app-server-transport.js';
import { CODEX_COMPACTION_STOPPED_COPY } from '../notification-mapper.js';

type Harness = ReturnType<typeof makeAppServerHarness>;
const harnesses: Harness[] = [];
function harness(options?: Parameters<typeof makeAppServerHarness>[0]): Harness {
  const h = makeAppServerHarness(options);
  harnesses.push(h);
  return h;
}
afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((h) => h.pool.shutdown()));
});

const dones = (events: StreamEvent[]) => events.filter((event) => event.type === 'done');
const progress = (events: StreamEvent[]) =>
  events
    .filter((event) => event.type === 'operation_progress')
    .map((event) => (event.data as { state: string }).state);
const boundaries = (events: StreamEvent[]) =>
  events.filter((event) => event.type === 'compact_boundary');

/** One finished turn on `s1`, so the session has a thread with a conversation in it. */
async function withConversation(h: Harness): Promise<string> {
  await h.run(h.request({ sessionId: 's1' }));
  return h.bindings[0]!.threadId;
}

describe('compacting a Codex thread', () => {
  it('asks thread/compact/start and streams progress, the boundary and one done', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    const events = await h.compact({ sessionId: 's1', boundThreadId: threadId });

    for (const event of events) StreamEventSchema.parse(event);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/compact/start')).toEqual([{ threadId }]);
    // No prompt is sent: the only turn/start is the conversation's own.
    expect(fake.requestsOf('turn/start')).toHaveLength(1);
    expect(progress(events)).toEqual(['started', 'done']);
    // `manual` (it was asked for); before = the last turn's 1,200 tokens,
    // after = the usage Codex reported during the summary.
    expect(boundaries(events)).toEqual([
      {
        type: 'compact_boundary',
        data: {
          trigger: 'manual',
          preTokens: 1200,
          postTokens: COMPACTED_TOKENS,
          durationMs: 7277,
        },
      },
    ]);
    expect(events.find((e) => e.type === 'session_status')).toMatchObject({
      data: { terminalReason: 'completed', contextTokens: COMPACTED_TOKENS },
    });
    expect(dones(events)).toHaveLength(1);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('adopts the turn whichever comes first, its turn/started or the answer', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    h.host.home(PERSON_HOME).processes[0]!.compactionStartsBeforeAnswer = true;
    const events = await h.compact({ sessionId: 's1', boundThreadId: threadId });
    expect(boundaries(events)).toHaveLength(1);
    expect(dones(events)).toHaveLength(1);
  });

  it('is an open turn while it runs: running warmth, no steer, and a stop ends it', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    h.host.home(PERSON_HOME).compactionScripts.push(parkedCompactionTurn);
    const gen = h.transport.compact({ ...h.request({ sessionId: 's1', boundThreadId: threadId }) });
    const first = await gen.next();
    expect(first.value).toMatchObject({ type: 'operation_progress', data: { state: 'started' } });
    expect(h.transport.getSessionWarmth('s1')).toBe('running');
    // A compaction cannot take input; the message waits for the next turn.
    expect(
      await h.transport.deliverIntoTurn('s1', 'more', { mode: 'steer', messageId: 'm2' })
    ).toEqual({ delivered: false, reason: 'no-open-turn' });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('turn/steer')).toHaveLength(0);
    // A second turn is refused rather than joined into the compaction.
    const second = await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(second[0]).toMatchObject({ type: 'error', data: { code: 'turn_open' } });

    expect(await h.transport.interrupt('s1')).toMatchObject({ outcome: 'acked' });
    const rest: StreamEvent[] = [];
    for await (const event of gen) rest.push(event);
    expect(rest).toContainEqual({
      type: 'operation_progress',
      data: {
        operation: 'compaction',
        state: 'failed',
        determinate: false,
        error: CODEX_COMPACTION_STOPPED_COPY,
      },
    });
    expect(boundaries(rest)).toHaveLength(0);
    expect(dones(rest)).toHaveLength(1);
    expect(h.transport.getSessionWarmth('s1')).toBe('warm');
  });

  it('reports a summary Codex could not make as failed, with the error and one done', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    h.host.home(PERSON_HOME).compactionScripts.push(failedCompactionTurn);
    const events = await h.compact({ sessionId: 's1', boundThreadId: threadId });
    expect(progress(events)).toEqual(['started', 'failed']);
    expect(boundaries(events)).toHaveLength(0);
    expect(events.some((e) => e.type === 'error')).toBe(true);
    expect(dones(events)).toHaveLength(1);
  });

  it('says so, and ends, when Codex accepts the summary but never opens its turn', async () => {
    const h = harness({ compactionStartMs: 50 });
    const threadId = await withConversation(h);
    h.host.home(PERSON_HOME).processes[0]!.compactionNeverStarts = true;
    const events = await h.compact({ sessionId: 's1', boundThreadId: threadId });
    expect(events).toContainEqual({
      type: 'error',
      data: { message: COMPACTION_NOT_STARTED_COPY, code: 'compaction_not_started' },
    });
    expect(dones(events)).toHaveLength(1);
    // The session is not left looking busy.
    expect(h.transport.getSessionWarmth('s1')).toBe('warm');
  });

  it('starts no thread for a session with no conversation, and says there is nothing to summarize', async () => {
    const h = harness();
    const events = await h.compact({ sessionId: 's-new' });
    expect(events).toEqual([
      {
        type: 'operation_progress',
        data: {
          operation: 'compaction',
          state: 'failed',
          determinate: false,
          error: NOTHING_TO_SUMMARIZE_COPY,
        },
      },
      { type: 'done', data: { sessionId: 's-new' } },
    ]);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/start')).toHaveLength(0);
    expect(fake.requestsOf('thread/compact/start')).toHaveLength(0);
  });

  it('never starts a fresh thread when Codex lost the bound one, and says so', async () => {
    const h = harness();
    const events = await h.compact({ sessionId: 's1', boundThreadId: 'gone' });
    expect(progress(events)).toEqual(['failed']);
    expect(events[0]).toMatchObject({ data: { error: CONVERSATION_GONE_COPY } });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/start')).toHaveLength(0);
    expect(h.bindings).toHaveLength(0);
  });

  it('resumes a cold thread without its tools, and the next turn reloads it with them', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    // The process goes away (a restart, a crash): the next one has nothing loaded.
    h.host.home(PERSON_HOME).processes[0]!.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const events = await h.compact({ sessionId: 's1', boundThreadId: threadId });
    expect(boundaries(events)).toHaveLength(1);
    // The conversation's size outlives the process that held it.
    expect(boundaries(events)[0]!.data).toMatchObject({ preTokens: 1200 });
    const cold = h.host.home(PERSON_HOME).processes[1]!;
    expect(cold.requestsOf('thread/resume')).toHaveLength(1);
    expect(JSON.stringify(cold.requestsOf('thread/resume')[0]!.config)).not.toContain(
      'mcp_servers'
    );

    // The next prompt reloads the thread with its own config (a fork carrying
    // the summarized conversation), rather than running without its tools.
    const managed = {
      agentTokenEnv: {},
      managed: {
        servers: { notion: { url: 'https://n.example/mcp' } },
        env: {},
      },
      dorkosTools: null,
      connectorTools: null,
    };
    await h.run(h.request({ sessionId: 's1', boundThreadId: threadId, tools: managed }));
    const fork = cold.requestsOf('thread/fork');
    expect(fork).toHaveLength(1);
    expect(fork[0]!.threadId).toBe(threadId);
    expect(JSON.stringify(fork[0]!.config)).toContain('n.example');
    expect(h.bindings.at(-1)).toMatchObject({ sessionId: 's1', replaces: threadId });
    expect(h.pool.list().every((process) => !process.stale)).toBe(true);
  });

  it('keeps a cold-loaded thread for a next turn that wants no tools either, without a fork', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    h.host.home(PERSON_HOME).processes[0]!.exit(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await h.compact({ sessionId: 's1', boundThreadId: threadId });
    const events = await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(dones(events)).toHaveLength(1);
    const cold = h.host.home(PERSON_HOME).processes[1]!;
    expect(cold.requestsOf('thread/fork')).toHaveLength(0);
    expect(cold.requestsOf('turn/start')[0]).toMatchObject({ threadId });
    expect(h.pool.list().every((process) => !process.stale)).toBe(true);
  });

  it('uses a warm thread as it is, without marking its process stale', async () => {
    const h = harness();
    const threadId = await withConversation(h);
    await h.compact({ sessionId: 's1', boundThreadId: threadId });
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    expect(fake.requestsOf('thread/resume')).toHaveLength(0);
    expect(fake.requestsOf('thread/fork')).toHaveLength(0);
    expect(h.pool.list()[0]!.stale).toBe(false);
    // And the next turn runs on the same thread.
    await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(fake.requestsOf('thread/fork')).toHaveLength(0);
    expect(fake.requestsOf('turn/start')).toHaveLength(2);
  });
});

describe('work that finishes during a summary', () => {
  it('is not shown inside the summary, and wakes the chat once the summary ends', async () => {
    const h = harness();
    const seen: BackgroundWake[] = [];
    h.transport.onWake((wake) => {
      seen.push(wake);
      return true;
    });
    // The agent leaves a command running and ends its turn…
    const bg = backgroundCommandTurn();
    h.host.home(PERSON_HOME).nextTurn(bg.script);
    await h.run(h.request({ sessionId: 's1' }));
    const threadId = h.bindings[0]!.threadId;
    // …then its summary runs, and the command finishes in the middle of it.
    h.host.home(PERSON_HOME).compactionScripts.push(async (ctx) => {
      const item = { type: 'contextCompaction', id: 'compact-mid' };
      ctx.emit('item/started', { item });
      bg.finish(0, 'tests passed\n');
      await ctx.tick();
      await ctx.tick();
      ctx.emit('item/completed', { item });
      ctx.complete('completed');
    });
    const events = await h.compact({ sessionId: 's1', boundThreadId: threadId });
    expect(events.some((e) => e.type === 'background_task_done')).toBe(false);
    for (let i = 0; i < 200 && seen.length === 0; i += 1) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.completions).toEqual([
      expect.objectContaining({ taskId: bg.itemId, status: 'completed' }),
    ]);
  });
});

describe('a summary that opens after DorkOS gave up on it', () => {
  it('is stopped, and the next message waits for it rather than joining it', async () => {
    const h = harness({ compactionStartMs: 30, stopAckMs: 1_000 });
    const threadId = await withConversation(h);
    const fake = h.host.home(PERSON_HOME).processes[0]!;
    fake.compactionStartDelayMs = 150;
    h.host.home(PERSON_HOME).compactionScripts.push(parkedCompactionTurn);
    const gaveUp = await h.compact({ sessionId: 's1', boundThreadId: threadId });
    expect(gaveUp).toContainEqual({
      type: 'error',
      data: { message: COMPACTION_NOT_STARTED_COPY, code: 'compaction_not_started' },
    });

    // The person sends a message before the late summary opens.
    const next = await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
    expect(next.map((e) => e.type)).not.toContain('error');
    expect(next.filter((e) => e.type === 'text_delta').length).toBeGreaterThan(0);
    // The late summary was stopped, and the message ran as a turn of its own.
    expect(fake.requestsOf('turn/interrupt').length).toBeGreaterThan(0);
    const turnStarts = fake.requestsOf('turn/start');
    expect(turnStarts).toHaveLength(2);
    expect(fake.loaded.get(threadId)!.activeTurn).toBeUndefined();
  });
});

describe('a summary Codex never opens at all', () => {
  it('holds only the first message after it, never every message for the watch window', async () => {
    const h = harness({ compactionStartMs: 20, stopAckMs: 400 });
    const threadId = await withConversation(h);
    h.host.home(PERSON_HOME).processes[0]!.compactionNeverStarts = true;
    await h.compact({ sessionId: 's1', boundThreadId: threadId });

    const timed = async () => {
      const started = Date.now();
      await h.run(h.request({ sessionId: 's1', boundThreadId: threadId }));
      return Date.now() - started;
    };
    // The first waits (bounded) for the late start; the next ones do not.
    expect(await timed()).toBeGreaterThanOrEqual(350);
    expect(await timed()).toBeLessThan(200);
    expect(await timed()).toBeLessThan(200);
  });
});
