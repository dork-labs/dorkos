import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Doe } from '../../doe.js';
import { SqliteModelStore } from '../../store.js';
import { DeferredToolRegistry, createToolSearch } from '../../registry/registry.js';
import type { DoeConfig, DoeEvent, ToolDescriptor } from '../../contracts.js';
import { createBeatExtension, validateBeatOutcome } from '../beat.js';
import { beatFixture } from './beat-fixture.js';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function config(endpoint = 'http://localhost:1/v1', file = ':memory:'): DoeConfig {
  const store = new SqliteModelStore(file);
  cleanups.push(() => store.close());
  return {
    sessionId: 'test',
    workingDirectory: '/tmp',
    store,
    registry: new DeferredToolRegistry(),
    model: {
      protocol: 'openai-completions',
      endpoint,
      id: 'local',
      payer: 'host',
      historyFamily: 'chat',
      contextWindow: 10000,
      maxOutputTokens: 100,
      credentials: async () => 'fixture-key',
      supportsThinking: true,
    },
    resources: {
      load: async () => 'host instructions',
      beforeFile: async () => '',
      skills: async () => [],
      loadSkill: async () => '',
    },
    pathPolicy: { readRoots: [], writeRoots: [] },
    extensions: { runBeat: createBeatExtension() },
  };
}
function add(c: DoeConfig, name: string, execute: ToolDescriptor['execute']) {
  c.registry.register({
    name,
    description: name,
    schema: { type: 'object', properties: {} },
    initialLoad: true,
    execute,
  });
}
it('skip persists its reason without model execution and refuses repeated IDs', async () => {
  const c = config();
  const factory = vi.fn();
  const doe = new Doe(c, factory);
  expect(
    await doe.runBeat({
      id: 'one',
      prompt: 'check',
      decide: async () => ({ action: 'skip', reason: 'unchanged' }),
    })
  ).toEqual({ kind: 'skipped', reason: 'unchanged' });
  expect(factory).not.toHaveBeenCalled();
  expect(c.store.outcomes('test', 'beat:one')[0]?.result).toEqual({
    kind: 'skipped',
    reason: 'unchanged',
  });
  await expect(doe.runBeat({ id: 'one', prompt: 'again' })).rejects.toThrow('already');
});
it('quiet ends after the full tool batch and preserves main context plus opaque beat history across reopen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'doe-beat-'));
  cleanups.unshift(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'history.db');
  const fixture = await beatFixture([
    [
      { name: 'end_beat', args: { kind: 'quiet' } },
      { name: 'effect', args: {} },
    ],
  ]);
  cleanups.push(fixture.close);
  const c = config(fixture.endpoint, file);
  c.store.createSession('test');
  c.store.appendMessage('test', { role: 'user', content: 'MAIN SECRET' });
  c.store.appendMessage('test', { role: 'user', content: 'retain main' });
  c.store.checkpoint('test', {
    summary: { role: 'user', content: 'MAIN SECRET summary' },
    firstRetainedSeq: 2,
    before: { tokens: 20, source: 'estimated' },
    after: { tokens: 10, source: 'estimated' },
    usage: { requestId: 'main-summary', inputTokens: 10, outputTokens: 2 },
  });
  const main = JSON.stringify(c.store.restore('test'));
  const mainArchive = JSON.stringify(c.store.archive('test'));
  const calls = vi.fn(async () => ({ content: [{ type: 'text', text: 'done' }] }));
  add(c, 'effect', calls);
  const events: DoeEvent[] = [];
  c.onEvent = (e) => events.push(e);
  expect(
    await new Doe(c).runBeat({
      id: 'quiet',
      prompt: 'check',
      changes: 'new order',
      instructions: 'be calm',
      commitments: 'already raised invoice',
    })
  ).toEqual({ kind: 'quiet' });
  expect(calls).toHaveBeenCalledOnce();
  expect(fixture.bodies).toHaveLength(1);
  expect(JSON.stringify(fixture.bodies)).not.toContain('MAIN SECRET');
  expect(JSON.stringify(fixture.bodies)).toContain('new order');
  expect(JSON.stringify(c.store.restore('test'))).toBe(main);
  expect(events.filter((e) => e.type === 'complete').map((e) => e.scope)).toEqual(['beat:quiet']);
  const starts = events.filter((e) => e.type === 'tool-start');
  const ends = events.filter((e) => e.type === 'tool-end');
  expect(starts.flatMap((e) => (e.type === 'tool-start' ? [e.callId] : []))).toEqual(
    ends.flatMap((e) => (e.type === 'tool-end' ? [e.callId] : []))
  );
  expect(events.every((e) => e.scope === 'beat:quiet')).toBe(true);
  const reopened = new SqliteModelStore(file);
  cleanups.push(() => reopened.close());
  expect(reopened.outcomes('test', 'beat:quiet')[0]?.result).toEqual({ kind: 'quiet' });
  expect(JSON.stringify(reopened.archive('test', 'beat:quiet'))).toContain('opaque thinking');
  expect(reopened.usage('test', 'beat:quiet')).toHaveLength(1);
  expect(reopened.usage('test', 'beat:quiet')[0]?.purpose).toBe('beat');
  expect(JSON.stringify(reopened.archive('test'))).toBe(mainArchive);
  expect(JSON.stringify(reopened.restore('test'))).toBe(main);
  await expect(new Doe(c).runBeat({ id: 'quiet', prompt: 'replay' })).rejects.toThrow('already');
  expect(fixture.bodies).toHaveLength(1);
});
it('validates bounded raises and reports them without invoking notification tools', async () => {
  const outcome = {
    kind: 'raises' as const,
    raises: [{ message: 'decision needed', rung: 'report' as const }],
  };
  expect(validateBeatOutcome(outcome)).toEqual(outcome);
  for (const value of [
    { kind: 'quiet', extra: true },
    { kind: 'quiet', raises: null },
    { kind: 'raises', raises: [] },
    { kind: 'raises', raises: [{ message: 'x', rung: 'stranger' }] },
    { kind: 'raises', raises: [{ message: 'x'.repeat(2001), rung: 'dm' }] },
    { kind: 'raises', raises: Array.from({ length: 9 }, () => ({ message: 'x', rung: 'dm' })) },
    { kind: 'skipped', reason: 'x' },
  ])
    expect(() => validateBeatOutcome(value)).toThrow();
  const fixture = await beatFixture([[{ name: 'end_beat', args: outcome }]]);
  cleanups.push(fixture.close);
  const c = config(fixture.endpoint);
  const post = vi.fn(async () => ({ content: [] }));
  add(c, 'notify', post);
  expect(await new Doe(c).runBeat({ id: 'raises', prompt: 'check' })).toEqual(outcome);
  expect(post).not.toHaveBeenCalled();
  expect(fixture.bodies).toHaveLength(1);
});
it('free text and failed sibling tools cannot become quiet completion', async () => {
  for (const failed of [false, true]) {
    const fixture = await beatFixture(
      failed
        ? [
            [
              { name: 'end_beat', args: { kind: 'quiet' } },
              { name: 'effect', args: {} },
            ],
          ]
        : []
    );
    cleanups.push(fixture.close);
    const c = config(fixture.endpoint);
    if (failed) add(c, 'effect', async () => ({ content: [], isError: true }));
    await expect(new Doe(c).runBeat({ id: 'failure', prompt: 'check' })).rejects.toThrow();
    expect(c.store.outcomes('test', 'beat:failure')).toEqual([]);
  }
});
it('abort settles preflight, holds same-session guard and permits an independent session', async () => {
  const c = config();
  const factory = vi.fn();
  const doe = new Doe(c, factory);
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  const pending = doe.runBeat({
    id: 'pending',
    prompt: 'check',
    decide: () => {
      started();
      return new Promise(() => {});
    },
  });
  const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  await entered;
  await expect(new Doe(c, factory).run('overlap')).rejects.toThrow('active');
  expect(
    await new Doe({ ...c, sessionId: 'other' }, factory).runBeat({
      id: 'independent',
      prompt: 'check',
      decide: async () => ({ action: 'skip', reason: 'clear' }),
    })
  ).toEqual({ kind: 'skipped', reason: 'clear' });
  doe.abort();
  await rejected;
  expect(factory).not.toHaveBeenCalled();
  expect(c.store.outcomes('test', 'beat:pending')).toEqual([]);
});
for (const waiting of ['approval', 'tool', 'child'] as const)
  it(`beat abort settles pending ${waiting} and never persists a latched quiet outcome`, async () => {
    const fixture = await beatFixture(
      waiting === 'approval'
        ? [[{ name: 'end_beat', args: { kind: 'quiet' } }]]
        : waiting === 'tool'
          ? [
              [
                { name: 'end_beat', args: { kind: 'quiet' } },
                { name: 'wait', args: {} },
              ],
            ]
          : [
              [
                { name: 'end_beat', args: { kind: 'quiet' } },
                { name: 'child', args: {} },
              ],
              [{ name: 'wait', args: {} }],
            ]
    );
    cleanups.push(fixture.close);
    const c = config(fixture.endpoint);
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let cancelled = false;
    const wait: ToolDescriptor['execute'] = async (_args, ctx) =>
      new Promise((_resolve, reject) => {
        ctx.signal.addEventListener(
          'abort',
          () => {
            cancelled = true;
            reject(ctx.signal.reason);
          },
          { once: true }
        );
        entered();
      });
    if (waiting === 'approval')
      c.approve = async (_tool, _args, ctx) =>
        new Promise((_resolve, reject) => {
          ctx.signal.addEventListener(
            'abort',
            () => {
              cancelled = true;
              reject(ctx.signal.reason);
            },
            { once: true }
          );
          entered();
        });
    if (waiting === 'tool') add(c, 'wait', wait);
    if (waiting === 'child')
      add(c, 'child', async (_args, ctx) => {
        await ctx.execute!({
          prompt: 'child',
          messages: [{ role: 'user', content: 'wait', timestamp: 1 }],
          tools: [
            {
              name: 'wait',
              description: 'wait',
              schema: { type: 'object', properties: {} },
              execute: wait,
            },
          ],
          scope: 'child:beat_child',
          purpose: 'builder',
        });
        return { content: [] };
      });
    const events: DoeEvent[] = [];
    c.onEvent = (e) => events.push(e);
    const doe = new Doe(c);
    const pending = doe.runBeat({ id: 'abort', prompt: 'check' });
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    await started;
    doe.abort();
    await rejected;
    expect(cancelled).toBe(true);
    expect(c.store.outcomes('test', 'beat:abort')).toEqual([]);
    expect(c.store.archive('test')).toEqual([]);
    const starts = events.flatMap((e) =>
      e.type === 'tool-start' ? [`${e.scope}:${e.callId}`] : []
    );
    const ends = events.flatMap((e) => (e.type === 'tool-end' ? [`${e.scope}:${e.callId}`] : []));
    expect(ends).toEqual(starts);
    expect(events.filter((e) => e.type === 'aborted').map((e) => e.scope)).toEqual(['beat:abort']);
    expect(events.some((e) => e.type === 'complete')).toBe(false);
  });
it('rejects malformed inputs and decisions before requesting a model, and preserves a run decision reason', async () => {
  const c = config();
  const factory = vi.fn();
  const doe = new Doe(c, factory);
  for (const request of [
    { id: 'bad', prompt: '' },
    { id: 'long', prompt: 'x'.repeat(32769) },
    {
      id: 'decision',
      prompt: 'check',
      decide: async () => ({ action: 'skip' as const, reason: '' }),
    },
  ])
    await expect(doe.runBeat(request)).rejects.toThrow();
  expect(factory).not.toHaveBeenCalled();
  const fixture = await beatFixture([[{ name: 'end_beat', args: { kind: 'quiet' } }]]);
  cleanups.push(fixture.close);
  const real = config(fixture.endpoint);
  await new Doe(real).runBeat({
    id: 'reason',
    prompt: 'check',
    decide: async () => ({ action: 'run', reason: 'deadline changed' }),
  });
  expect(JSON.stringify(real.store.archive('test', 'beat:reason'))).toContain('deadline changed');
});
it('does not claim completion when outcome persistence fails or a prior failed beat ID is retried', async () => {
  const fixture = await beatFixture([[{ name: 'end_beat', args: { kind: 'quiet' } }]]);
  cleanups.push(fixture.close);
  const c = config(fixture.endpoint);
  const events: DoeEvent[] = [];
  c.onEvent = (e) => events.push(e);
  const record = vi.spyOn(c.store, 'recordOutcome').mockImplementation(() => {
    throw new Error('outcome disk failure');
  });
  const doe = new Doe(c);
  await expect(doe.runBeat({ id: 'disk', prompt: 'check' })).rejects.toThrow('disk failure');
  expect(events.some((e) => e.type === 'complete')).toBe(false);
  expect(c.store.outcomes('test', 'beat:disk')).toEqual([]);
  record.mockRestore();
  await expect(doe.runBeat({ id: 'disk', prompt: 'retry' })).rejects.toThrow('already');
  expect(fixture.bodies).toHaveLength(1);
});
it('refuses errored, length-stopped and aborted model runs even after end_beat has latched an outcome', async () => {
  for (const stopReason of ['error', 'length', 'aborted'] as const) {
    const c = config();
    const doe = new Doe(c, () => ({
      run: async (r) => {
        await r.tools.find((t) => t.name === 'end_beat')!.execute({ kind: 'quiet' }, r.context);
        return { messages: [], scope: r.context.scope, stopReason };
      },
      steer: () => 'idle',
      followUp: () => 'idle',
      abort: () => {},
    }));
    await expect(doe.runBeat({ id: stopReason, prompt: 'check' })).rejects.toThrow();
    expect(c.store.outcomes('test', `beat:${stopReason}`)).toEqual([]);
  }
});
it('malformed end_beat and repeated raises never persist successful outcomes', async () => {
  const malformed = {
    kind: 'raises',
    raises: [
      { message: 'same issue', rung: 'dm' },
      { message: 'same issue', rung: 'notification' },
    ],
  };
  expect(() => validateBeatOutcome(malformed)).toThrow('once');
  const fixture = await beatFixture([[{ name: 'end_beat', args: malformed }]]);
  cleanups.push(fixture.close);
  const c = config(fixture.endpoint);
  await expect(new Doe(c).runBeat({ id: 'malformed', prompt: 'check' })).rejects.toThrow(
    'without end_beat'
  );
  expect(c.store.outcomes('test', 'beat:malformed')).toEqual([]);
  expect(
    c.store
      .archive('test', 'beat:malformed')
      .some((r) => r.payload.role === 'toolResult' && r.payload.isError === true)
  ).toBe(true);
});

it('refreshes deferred tools during the beat without exposing end_beat in the main registry', async () => {
  const fixture = await beatFixture([
    [{ name: 'tool_search', args: { query: 'calendar', limit: 1 } }],
    [
      { name: 'calendar', args: {} },
      { name: 'end_beat', args: { kind: 'quiet' } },
    ],
  ]);
  cleanups.push(fixture.close);
  const c = config(fixture.endpoint);
  c.registry.register(createToolSearch(c.registry));
  const effect = vi.fn(async () => ({ content: [] }));
  c.registry.register({
    name: 'calendar',
    description: 'calendar appointments',
    schema: { type: 'object', properties: {} },
    execute: effect,
  });
  expect(await new Doe(c).runBeat({ id: 'deferred', prompt: 'check calendar' })).toEqual({
    kind: 'quiet',
  });
  expect(effect).toHaveBeenCalledOnce();
  expect(fixture.bodies).toHaveLength(2);
  expect(JSON.stringify(fixture.bodies[1]?.tools)).toContain('calendar');
  expect(JSON.stringify(fixture.bodies[1]?.tools)).toContain('end_beat');
  expect(c.registry.selected().some((t) => t.name === 'end_beat')).toBe(false);
});
it('includes the reserved end_beat schema in beat budgets and rejects collisions atomically', async () => {
  const c = config();
  const factory = vi.fn();
  for (let i = 0; i < 64; i++) add(c, `host_${i}`, async () => ({ content: [] }));
  await expect(new Doe(c, factory).runBeat({ id: 'full', prompt: 'check' })).rejects.toThrow(
    'budget'
  );
  expect(factory).not.toHaveBeenCalled();
  expect(c.registry.selected()).toHaveLength(64);
  const collision = config();
  add(collision, 'end_beat', async () => ({ content: [] }));
  await expect(
    new Doe(collision, factory).runBeat({ id: 'collision', prompt: 'check' })
  ).rejects.toThrow('reserved');
  expect(factory).not.toHaveBeenCalled();
  const small = config();
  small.extensions = { runBeat: createBeatExtension({ maxSchemaBytes: 10 }) };
  await expect(new Doe(small, factory).runBeat({ id: 'schema', prompt: 'check' })).rejects.toThrow(
    'budget'
  );
});

it('permits a corrected end_beat after an earlier failed tool batch', async () => {
  const fixture = await beatFixture([
    [{ name: 'end_beat', args: { kind: 'quiet', unexpected: true } }],
    [{ name: 'end_beat', args: { kind: 'quiet' } }],
  ]);
  cleanups.push(fixture.close);
  const c = config(fixture.endpoint);
  expect(await new Doe(c).runBeat({ id: 'recovered', prompt: 'check' })).toEqual({ kind: 'quiet' });
  expect(fixture.bodies).toHaveLength(2);
  expect(c.store.outcomes('test', 'beat:recovered')).toHaveLength(1);
});

it('refuses quiet completion after denied approval while allowing ordinary tool-error recovery', async () => {
  for (const denied of [true, false]) {
    const wire = await beatFixture([
      [{ name: 'effect', args: {} }],
      [{ name: 'end_beat', args: { kind: 'quiet' } }],
    ]);
    cleanups.push(wire.close);
    const c = config(wire.endpoint);
    const effect = vi.fn(async () => ({ content: [], isError: true }));
    add(c, 'effect', effect);
    c.approve = async (request) => (denied && request.name === 'effect' ? 'deny' : 'allow');
    const events: DoeEvent[] = [];
    c.onEvent = (event) => events.push(event);
    const result = new Doe(c).runBeat({ id: 'approval', prompt: 'check' });
    if (denied) {
      await expect(result).rejects.toThrow('approval');
      expect(effect).not.toHaveBeenCalled();
      expect(c.store.outcomes('test', 'beat:approval')).toEqual([]);
      expect(events.some((event) => event.type === 'complete')).toBe(false);
    } else {
      expect(await result).toEqual({ kind: 'quiet' });
      expect(effect).toHaveBeenCalledOnce();
      expect(c.store.outcomes('test', 'beat:approval')).toHaveLength(1);
    }
    expect(wire.bodies).toHaveLength(2);
  }
});

for (const table of ['messages', 'usage'] as const) {
  it(`late owned beat child ${table} failure prevents quiet outcome before parent settlement`, async () => {
    const { default: Database } = await import('better-sqlite3');
    const { PiEngine } = await import('../../pi-engine.js');
    const directory = mkdtempSync(join(tmpdir(), 'beat-late-'));
    cleanups.unshift(() => rmSync(directory, { recursive: true, force: true }));
    const file = join(directory, 'history.sqlite');
    const wire = await beatFixture([
      [
        { name: 'launch', args: {} },
        { name: 'end_beat', args: { kind: 'quiet' } },
      ],
    ]);
    cleanups.push(wire.close);
    const c = config(wire.endpoint, file);
    const database = new Database(file);
    database.exec(
      `CREATE TRIGGER refuse_child BEFORE INSERT ON ${table} WHEN NEW.scope = 'child:late' BEGIN SELECT RAISE(ABORT, 'late child storage failure'); END`
    );
    database.close();
    add(c, 'launch', async (_args, context) => {
      void context.execute!({
        scope: 'child:late',
        purpose: 'builder',
        prompt: 'child',
        messages: [],
        tools: [],
      }).catch(() => {});
      return { content: [] };
    });
    const events: DoeEvent[] = [];
    c.onEvent = (event) => events.push(event);
    let childFailure: unknown;
    let childFinished = false;
    const factory = () => ({
      abort() {},
      steer() {
        return 'idle' as const;
      },
      followUp() {
        return 'idle' as const;
      },
      async run(request: import('../../engine.js').EngineRequest) {
        if (request.context.scope.startsWith('beat:')) return new PiEngine().run(request);
        await new Promise<void>((resolve) =>
          request.signal.addEventListener('abort', () => resolve(), { once: true })
        );
        await new Promise<void>((resolve) => setImmediate(resolve));
        try {
          await request.onUsage({ requestId: 'late-child', inputTokens: 12, outputTokens: 3 });
          await request.onMessage({ role: 'assistant', content: 'owned child cleanup' });
        } catch (error) {
          childFailure = error;
          throw error;
        } finally {
          childFinished = true;
        }
        return { messages: [], stopReason: 'aborted' as const, scope: request.context.scope };
      },
    });
    const failure = await new Doe(c, factory)
      .runBeat({ id: 'late', prompt: 'check' })
      .catch((error) => error);
    expect(failure).toBe(childFailure);
    expect(failure).toBeInstanceOf(Error);
    expect(childFinished).toBe(true);
    expect(c.store.outcomes('test', 'beat:late')).toEqual([]);
    expect(events.some((event) => event.type === 'complete')).toBe(false);
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', scope: 'beat:late', error: 'late child storage failure' },
    ]);
    expect(c.store.archive('test', 'beat:late').length).toBeGreaterThan(0);
    expect(c.store.usage('test', 'child:late')).toHaveLength(table === 'usage' ? 0 : 1);
    expect(wire.bodies).toHaveLength(1);
  });
}

for (const protocol of ['anthropic-messages', 'openai-completions', 'openai-responses'] as const) {
  it(`advertises a usable end_beat object schema and completes quiet/raises through ${protocol}`, async () => {
    const { protocolFixture } = await import('../../__tests__/protocol-fixture.js');
    for (const outcome of [
      { kind: 'quiet' },
      { kind: 'raises', raises: [{ message: 'decision needed', rung: 'report' }] },
    ]) {
      const wire = await protocolFixture(protocol, { tool: 'end_beat', toolArguments: outcome });
      cleanups.push(wire.close);
      const c = config(wire.endpoint);
      c.model = { ...c.model, protocol, historyFamily: protocol };
      expect(await new Doe(c).runBeat({ id: 'wire', prompt: 'check' })).toEqual(outcome);
      expect(wire.bodies).toHaveLength(1);
      const tool = (
        wire.bodies[0].tools as Array<{
          name?: string;
          strict?: boolean;
          input_schema?: ToolDescriptor['schema'];
          parameters?: ToolDescriptor['schema'];
          function?: { name: string; strict?: boolean; parameters: ToolDescriptor['schema'] };
        }>
      ).find((tool) => (tool.function?.name ?? tool.name) === 'end_beat')!;
      const schema = (tool.input_schema ?? tool.function?.parameters ?? tool.parameters) as {
        type: string;
        required: string[];
        properties: {
          kind: { enum: string[] };
          raises: {
            type: string;
            minItems: number;
            maxItems: number;
            anyOf?: unknown;
            items: { required: string[]; properties: { message: { maxLength: number } } };
          };
        };
      };
      expect(schema.type).toBe('object');
      expect(schema.properties.kind.enum).toEqual(['quiet', 'raises']);
      expect(schema.required).toEqual(['kind']);
      expect(schema.properties.raises.type).toBe('array');
      expect(schema.properties.raises.minItems).toBe(1);
      expect(schema.properties.raises.maxItems).toBe(8);
      expect(schema.properties.raises.items.required).toEqual(['message', 'rung']);
      expect(schema.properties.raises.items.properties.message.maxLength).toBe(2000);
      expect(tool.strict ?? tool.function?.strict ?? false).toBe(false);
      expect(schema.properties.raises.anyOf).toBeUndefined();
      expect(c.store.outcomes('test', 'beat:wire')).toHaveLength(1);
    }
  });
}
