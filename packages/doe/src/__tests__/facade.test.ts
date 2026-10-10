import { expect, it, vi } from 'vitest';
import { Doe } from '../doe.js';
import { SqliteModelStore } from '../store.js';
import { DeferredToolRegistry } from '../registry/registry.js';
import type { DoeConfig, ModelMessage } from '../contracts.js';
import type { Engine, EngineRequest } from '../engine.js';
function config(): DoeConfig {
  return {
    sessionId: 'test',
    workingDirectory: '/tmp',
    model: {
      protocol: 'openai-completions',
      endpoint: 'http://localhost:1/v1',
      id: 'local',
      contextWindow: 10000,
      maxOutputTokens: 100,
      payer: 'host',
      historyFamily: 'chat',
      requiresCredentials: false,
      credentials: vi.fn(async () => undefined),
    },
    store: new SqliteModelStore(':memory:'),
    registry: new DeferredToolRegistry(),
    resources: {
      load: vi.fn(async () => 'SUPPLIED-CONTEXT'),
      beforeFile: async () => '',
      skills: async () => [],
      loadSkill: async () => '',
    },
    pathPolicy: { readRoots: [], writeRoots: [] },
    profile: { role: 'accountant', manager: 'Dorian', goals: ['Revenue', 'Operations'] },
  };
}
it('constructs inertly and persists complete messages before exposing completion; prompt uses host facts', async () => {
  const c = config();
  const requests: EngineRequest[] = [];
  const events: string[] = [];
  c.onEvent = (e) => {
    events.push(e.type);
    if (e.type === 'complete') expect(c.store.archive('test').at(-1)?.payload.content).toBe('done');
  };
  const engine: Engine = {
    run: async (r) => {
      requests.push(r);
      await r.prepareRequest?.(r.messages, r.signal);
      const message = { role: 'assistant', content: 'done', opaque: { signature: 'preserved' } };
      await r.onMessage(message);
      await r.onUsage({ requestId: 'one' });
      return { messages: [message], scope: 'main', stopReason: 'stop' };
    },
    steer: () => 'queued',
    followUp: () => 'queued',
    abort: () => {},
  };
  const doe = new Doe(c, () => engine);
  expect(c.resources.load).not.toHaveBeenCalled();
  expect(c.model.credentials).not.toHaveBeenCalled();
  await doe.run('hello');
  expect(events.at(-1)).toBe('complete');
  const p = requests[0]!.prompt;
  expect(p).toContain('SUPPLIED-CONTEXT');
  expect(p).toContain('accountant');
  expect(p.indexOf('Revenue')).toBeLessThan(p.indexOf('Operations'));
  expect(p).not.toMatch(/git commit|shell|coding assistant/i);
  c.store.close();
});
it('uses engine queues, refuses overlap across facades and aborts pending work', async () => {
  const c = config();
  let request: EngineRequest | undefined;
  let release: (m: {
    messages: ModelMessage[];
    scope: 'main';
    stopReason: 'aborted';
  }) => void = () => {};
  const engine: Engine = {
    run: (r) => {
      request = r;
      return new Promise((resolve) => {
        release = resolve;
      });
    },
    steer: vi.fn(() => 'queued' as const),
    followUp: vi.fn(() => 'queued' as const),
    abort: vi.fn(() => release({ messages: [], scope: 'main', stopReason: 'aborted' })),
  };
  const doe = new Doe(c, () => engine);
  const other = new Doe(c, () => engine);
  const pending = doe.run('start');
  await vi.waitFor(() => expect(request).toBeDefined());
  await expect(other.run('overlap')).rejects.toThrow('active');
  expect(doe.steer('change')).toBe('queued');
  expect(doe.followUp('later')).toBe('queued');
  doe.abort();
  expect((await pending).stopReason).toBe('aborted');
  expect(engine.abort).toHaveBeenCalled();
  expect(doe.steer('idle')).toBe('idle');
  c.store.close();
});
it('isolates summary dialogue and usage while allowing checkpoint references; persistence failure never completes', async () => {
  const c = config();
  let usage = 0;
  const engine: Engine = {
    run: async (r) => {
      const message = { role: 'assistant', content: 'answer' };
      await r.onUsage({ requestId: `req-${++usage}` });
      await r.onMessage(message);
      return { messages: [message], scope: r.context.scope, stopReason: 'stop' };
    },
    steer: () => 'idle',
    followUp: () => 'idle',
    abort: () => {},
  };
  c.extensions = {
    compact: async (ctx) => {
      const result = await ctx.execute({
        prompt: 'summary',
        messages: [{ role: 'user', content: 'summarize', timestamp: 1 }],
        tools: [],
        scope: 'summary:one',
        purpose: 'summary',
      });
      expect(result.usage).toHaveLength(1);
      ctx.config.store.checkpoint('test', {
        summary: result.messages[0]!,
        firstRetainedSeq: 1,
        before: { tokens: 10, source: 'estimated' },
        after: { tokens: 3, source: 'estimated' },
        usage: result.usage[0]!,
        usageScope: 'summary:one',
      });
    },
  };
  const doe = new Doe(c, () => engine);
  await doe.compact();
  expect(c.store.archive('test')).toEqual([]);
  expect(c.store.archive('test', 'summary:one')).toHaveLength(2);
  const events: string[] = [];
  c.onEvent = (e) => events.push(e.type);
  vi.spyOn(c.store, 'appendMessage').mockImplementation(() => {
    throw new Error('disk failure');
  });
  await expect(doe.run('fail')).rejects.toThrow('disk failure');
  expect(events).not.toContain('complete');
  c.store.close();
});
it('locks a durable session across separate SQLite handles while unrelated sessions run independently', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'doe-lock-'));
  const c = config();
  c.store.close();
  c.store = new SqliteModelStore(join(dir, 'db'));
  const second = new SqliteModelStore(join(dir, 'db'));
  let release: () => void = () => {};
  let started = false;
  const engine: Engine = {
    run: (r) => {
      started = true;
      return new Promise((resolve) => {
        release = () => resolve({ messages: [], scope: r.context.scope, stopReason: 'stop' });
      });
    },
    steer: () => 'queued',
    followUp: () => 'queued',
    abort: () => release(),
  };
  try {
    const pending = new Doe(c, () => engine).run('first');
    await vi.waitFor(() => expect(started).toBe(true));
    await expect(new Doe({ ...c, store: second }, () => engine).run('second')).rejects.toThrow(
      'active'
    );
    const independentEngine: Engine = {
      ...engine,
      run: async (r) => ({ messages: [], scope: r.context.scope, stopReason: 'stop' }),
    };
    expect(
      (
        await new Doe(
          { ...c, store: second, sessionId: 'independent' },
          () => independentEngine
        ).run('other')
      ).stopReason
    ).toBe('stop');
    release();
    await pending;
  } finally {
    c.store.close();
    second.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
it('scoped execution preserves selected child tools/resources and ends after one full batch', async () => {
  const c = config();
  const requests: EngineRequest[] = [];
  const childResources = { ...c.resources, load: vi.fn(async () => 'CHILD ONLY') };
  const childTool = {
    name: 'child_only',
    description: 'child tool',
    schema: { type: 'object' },
    execute: async () => ({ content: [] }),
  };
  c.registry.register({
    name: 'parent_only',
    description: 'parent tool',
    schema: { type: 'object' },
    initialLoad: true,
    execute: async () => ({ content: [] }),
  });
  const factory = (): Engine => ({
    run: async (r) => {
      requests.push(r);
      const prepared = await r.prepareRequest?.(r.messages, r.signal);
      if (r.context.scope.startsWith('child:')) {
        expect(prepared?.tools?.map((t) => t.name)).toEqual(['child_only']);
        expect(prepared?.prompt).toContain('CHILD ONLY');
        expect(prepared?.prompt).not.toContain('SUPPLIED-CONTEXT');
        expect(await r.finishTurn?.([], r.signal)).toBe('end');
      }
      return { messages: [], scope: r.context.scope, stopReason: 'stop' };
    },
    steer: () => 'idle',
    followUp: () => 'idle',
    abort: () => {},
  });
  c.extensions = {
    compact: async (ctx) => {
      await ctx.execute({
        prompt: 'child prompt',
        messages: [{ role: 'user', content: 'child', timestamp: 1 }],
        tools: [childTool],
        scope: 'child:one',
        purpose: 'builder',
        resources: childResources,
        workingDirectory: '/tmp/approved',
        finishTurn: async () => 'end',
      });
      await expect(
        ctx.execute({
          prompt: 'bad',
          messages: [],
          tools: [],
          scope: 'child:bad',
          purpose: 'builder',
          model: { ...c.model, payer: 'other' },
        })
      ).rejects.toThrow('payer');
    },
  };
  await new Doe(c, factory).compact();
  expect(requests[0]?.context.workingDirectory).toBe('/tmp/approved');
  expect(c.resources.load).toHaveBeenCalledTimes(1);
  c.store.close();
});

it('bound execution refuses nested main and simultaneous reuse of an active scope', async () => {
  const c = config();
  let starts = 0;
  let release: () => void = () => {};
  const factory = (): Engine => ({
    run: async (r) => {
      starts++;
      if (r.context.scope === 'main' && starts === 1) {
        await expect(
          r.context.execute!({
            scope: 'main',
            purpose: 'run',
            prompt: 'nested',
            messages: [],
            tools: [],
          })
        ).rejects.toThrow('main');
        const options = {
          scope: 'child:one' as const,
          purpose: 'builder' as const,
          prompt: 'child',
          messages: [],
          tools: [],
        };
        const first = r.context.execute!(options);
        await vi.waitFor(() => expect(starts).toBe(2));
        await expect(r.context.execute!(options)).rejects.toThrow('active');
        release();
        await first;
      } else if (r.context.scope !== 'main')
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { messages: [], scope: r.context.scope, stopReason: 'stop' };
    },
    steer: () => 'idle',
    followUp: () => 'idle',
    abort: () => release(),
  });
  await new Doe(c, factory).run('hello');
  expect(starts).toBe(2);
  c.store.close();
});

for (const phase of ['initial', 'pre-request'] as const)
  it(`abort settles a pending ${phase} resource load and releases the session before late completion`, async () => {
    const c = config();
    let resolveLoad: (value: string) => void = () => {};
    let loads = 0;
    const held = new Promise<string>((resolve) => {
      resolveLoad = resolve;
    });
    c.resources.load = async () => (++loads === (phase === 'initial' ? 1 : 2) ? held : 'ready');
    const run = vi.fn(async (r: EngineRequest) => {
      await r.prepareRequest?.(r.messages, r.signal);
      await r.onMessage({ role: 'assistant', content: 'finished' });
      return { messages: [], scope: r.context.scope, stopReason: 'stop' as const };
    });
    const factory = (): Engine => ({
      run,
      steer: () => 'idle',
      followUp: () => 'idle',
      abort: () => {},
    });
    const doe = new Doe(c, factory);
    let settled = false;
    const pending = doe.run('old').catch((error) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(loads).toBe(phase === 'initial' ? 1 : 2));
    doe.abort();
    await vi.waitFor(() => expect(settled).toBe(true), { timeout: 200 });
    expect((await pending).name).toBe('AbortError');
    c.resources.load = async () => 'fresh';
    await new Doe(c, factory).run('new');
    const before = JSON.stringify(c.store.archive('test'));
    const starts = run.mock.calls.length;
    resolveLoad('LATE');
    await new Promise((resolve) => setImmediate(resolve));
    expect(run).toHaveBeenCalledTimes(starts);
    expect(JSON.stringify(c.store.archive('test'))).toBe(before);
    expect(c.store.archive('test').filter((r) => r.payload.role === 'assistant')).toHaveLength(1);
    c.store.close();
  });

it('beat failures use their validated operation scope and an empty ID never invokes its extension', async () => {
  const c = config();
  const events: import('../contracts.js').DoeEvent[] = [];
  c.onEvent = (event) => events.push(event);
  const runBeat = vi.fn(async () => {
    throw new Error('beat failed');
  });
  c.extensions = { runBeat };
  await expect(new Doe(c).runBeat({ id: 'one', prompt: 'beat' })).rejects.toThrow('beat failed');
  expect(events.at(-1)).toMatchObject({ type: 'error', scope: 'beat:one' });
  await expect(new Doe(c).runBeat({ id: '', prompt: 'beat' })).rejects.toThrow('beat id');
  expect(runBeat).toHaveBeenCalledTimes(1);
  c.store.close();
});

for (const operation of ['run', 'beat'] as const)
  it(`${operation} drains cancelled owned children before terminal delivery, settlement and session reuse`, async () => {
    const c = config();
    const events: import('../contracts.js').DoeEvent[] = [];
    c.onEvent = (event) => events.push(event);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release!: () => void;
    const cleanup = new Promise<void>((resolve) => {
      release = resolve;
    });
    const childController = new AbortController();
    const launch = (execute: NonNullable<import('../contracts.js').ToolContext['execute']>) => {
      const child = execute({
        scope: 'child:owned',
        purpose: 'builder',
        prompt: 'child',
        messages: [],
        tools: [],
        signal: childController.signal,
      });
      // The caller abandons its cancellation-aware wait, not the facade-owned engine.
      void child.catch(() => {});
    };
    const factory = (): Engine => ({
      run: async (r) => {
        if (r.context.scope === 'main') {
          launch(r.context.execute!);
          await started;
          childController.abort();
          return { messages: [], scope: r.context.scope, stopReason: 'stop' };
        }
        entered();
        await new Promise<void>((resolve) =>
          r.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        await cleanup;
        await r.onUsage({ requestId: 'owned-child', inputTokens: 12, outputTokens: 3 });
        await r.onMessage({ role: 'assistant', content: 'child cleanup complete' });
        return { messages: [], scope: r.context.scope, stopReason: 'aborted' };
      },
      abort: () => {},
      steer: () => 'idle',
      followUp: () => 'idle',
    });
    c.extensions = {
      runBeat: async (_request, context) => {
        launch(context.execute);
        await started;
        await new Promise<void>((resolve) =>
          context.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        throw context.signal.reason;
      },
    };
    const doe = new Doe(c, factory);
    let settled = false;
    const pending = (
      operation === 'run' ? doe.run('work') : doe.runBeat({ id: 'owned', prompt: 'check' })
    ).then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await started;
    if (operation === 'beat') doe.abort();
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    expect(events.filter((event) => ['complete', 'aborted', 'error'].includes(event.type))).toEqual(
      []
    );
    await expect(new Doe(c, factory).run('overlap')).rejects.toThrow('active');
    release();
    await pending;
    expect(c.store.allUsage('test')).toHaveLength(1);
    expect(c.store.archive('test', 'child:owned').at(-1)?.payload.content).toBe(
      'child cleanup complete'
    );
    const terminal = events.findIndex((event) =>
      ['complete', 'aborted', 'error'].includes(event.type)
    );
    expect(terminal).toBeGreaterThan(events.findIndex((event) => event.type === 'usage'));
    expect(events[terminal]).toMatchObject({
      type: operation === 'run' ? 'complete' : 'aborted',
      scope: operation === 'run' ? 'main' : 'beat:owned',
    });
    c.store.close();
  });

it('observes an abandoned owned child rejection while draining it before parent settlement', async () => {
  const c = config();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const factory = (): Engine => ({
    run: async (r) => {
      if (r.context.scope === 'main') {
        void r.context.execute!({
          scope: 'child:rejected',
          purpose: 'builder',
          prompt: '',
          messages: [],
          tools: [],
        });
        await started;
        return { scope: 'main', messages: [], stopReason: 'stop' };
      }
      entered();
      await new Promise<void>((resolve) =>
        r.signal.addEventListener('abort', () => resolve(), { once: true })
      );
      await new Promise((resolve) => setImmediate(resolve));
      await r.onUsage({ requestId: 'rejected-owned-child', inputTokens: 1 });
      throw new Error('owned child cleanup failed');
    },
    abort: () => {},
    steer: () => 'idle',
    followUp: () => 'idle',
  });
  await new Doe(c, factory).run('work');
  expect(c.store.allUsage('test')).toHaveLength(1);
  c.store.close();
  await new Promise((resolve) => setImmediate(resolve));
});
