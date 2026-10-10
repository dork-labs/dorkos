import { afterEach, expect, it, vi } from 'vitest';
import { Doe } from '../doe.js';
import { SqliteModelStore } from '../store.js';
import { DeferredToolRegistry, createToolSearch } from '../registry/registry.js';
import { protocolFixture } from './protocol-fixture.js';
import type { DoeConfig, DoeEvent, ModelDescriptor, ToolResult } from '../contracts.js';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
function setup(protocol: ModelDescriptor['protocol'], endpoint: string): DoeConfig {
  const store = new SqliteModelStore(':memory:');
  cleanups.push(() => store.close());
  return {
    sessionId: 'test',
    workingDirectory: '/tmp',
    model: {
      protocol,
      endpoint,
      id: 'local',
      contextWindow: 10000,
      maxOutputTokens: 100,
      payer: 'host',
      historyFamily: protocol,
      credentials: async () => 'explicit-fixture',
      supportsThinking: true,
      supportsImages: true,
    },
    store,
    registry: new DeferredToolRegistry(),
    resources: {
      load: async () => 'Host context',
      beforeFile: async () => '',
      skills: async () => [],
      loadSkill: async () => '',
    },
    pathPolicy: { readRoots: [], writeRoots: [] },
  };
}
for (const protocol of ['anthropic-messages', 'openai-completions', 'openai-responses'] as const) {
  it(`${protocol} actual local wire streams thinking/text and preserves tool exchanges and opaque JSON`, async () => {
    const fixture = await protocolFixture(protocol, { tool: 'echo', thinking: true });
    cleanups.push(fixture.close);
    const c = setup(protocol, fixture.endpoint);
    const calls = vi.fn(async (): Promise<ToolResult> => ({
      content: [
        { type: 'text', text: 'tool-output' },
        { type: 'image', data: 'YWJj', mimeType: 'image/png' },
      ],
      structuredContent: { opaque: true },
    }));
    c.registry.register({
      name: 'echo',
      description: 'Echo',
      initialLoad: true,
      schema: { type: 'object', properties: {} },
      execute: calls,
    });
    const events: DoeEvent[] = [];
    c.onEvent = (e) => events.push(e);
    const result = await new Doe(c).run('hello');
    expect(result.stopReason).toBe('stop');
    expect(fixture.requests()).toBe(2);
    expect(calls).toHaveBeenCalledTimes(1);
    expect(events.some((e) => e.type === 'thinking')).toBe(true);
    expect(events.some((e) => e.type === 'text')).toBe(true);
    expect(result.usage.map((u) => u.inputTokens)).toEqual([12, 12]);
    expect(result.usage[0]?.costUsd).toBeUndefined();
    const archive = c.store.archive('test');
    expect(archive.some((r) => r.payload.role === 'toolResult')).toBe(true);
    expect(JSON.stringify(archive)).toContain('opaque');
    if (protocol === 'anthropic-messages')
      expect(JSON.stringify(archive)).toContain('opaque-signature');
    if (protocol === 'openai-responses')
      expect(JSON.stringify(archive)).toContain('opaque-encrypted');
    expect(events.at(-1)?.type).toBe('complete');
  });
  it(`${protocol} missing provider usage remains unavailable`, async () => {
    const fixture = await protocolFixture(protocol, { usage: false });
    cleanups.push(fixture.close);
    const c = setup(protocol, fixture.endpoint);
    const result = await new Doe(c).run('hello');
    expect(result.stopReason).toBe(protocol === 'anthropic-messages' ? 'error' : 'stop');
    expect(result.usage).toHaveLength(1);
    expect(result.usage[0]?.inputTokens).toBeUndefined();
    expect(result.usage[0]?.outputTokens).toBeUndefined();
    expect(result.usage[0]?.costUsd).toBeUndefined();
  });
}
it('refuses subscription tokens and missing credentials before network despite ambient sentinel keys', async () => {
  const fixture = await protocolFixture('anthropic-messages');
  cleanups.push(fixture.close);
  const c = setup('anthropic-messages', fixture.endpoint);
  for (const key of ['sk-ant-oat-refused', undefined]) {
    c.model.credentials = async () => key;
    const result = await new Doe(c).run('hello');
    expect(result.stopReason).toBe('error');
  }
  expect(fixture.requests()).toBe(0);
});
it('honors absent credential validation and explicit local unauthenticated policy', async () => {
  const fixture = await protocolFixture('openai-completions');
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  c.model.requiresCredentials = false;
  c.model.credentials = async () => undefined;
  expect((await new Doe(c).run('hello')).stopReason).toBe('stop');
  expect(fixture.requests()).toBe(1);
});
it('refreshes discovered schemas before the next actual provider request', async () => {
  const fixture = await protocolFixture('openai-completions', { tool: 'tool_search' });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  const search = createToolSearch(c.registry);
  c.registry.register({
    ...search,
    schema: { type: 'object' },
    execute: (_a, context) => search.execute({ query: 'invoice', limit: 1 }, context),
  });
  c.registry.register({
    name: 'invoices',
    description: 'invoice billing',
    schema: { type: 'object' },
    execute: async () => ({ content: [] }),
  });
  expect((await new Doe(c).run('find invoice tools')).stopReason).toBe('stop');
  const second = fixture.bodies[1] as { tools?: Array<{ function: { name: string } }> };
  expect(second.tools?.map((t) => t.function.name)).toContain('invoices');
  expect(JSON.stringify(c.store.archive('test'))).toContain('toolsAdded');
});
it('Pi drains steering before follow-up using its existing queues', async () => {
  const fixture = await protocolFixture('openai-completions', { holdFirst: true });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  const doe = new Doe(c);
  const pending = doe.run('initial');
  await vi.waitFor(() => expect(fixture.requests()).toBe(1));
  expect(doe.steer('steering')).toBe('queued');
  expect(doe.followUp('follow-up')).toBe('queued');
  fixture.release();
  expect((await pending).stopReason).toBe('stop');
  expect(fixture.requests()).toBe(3);
  const users = fixture.bodies.map((b) =>
    (b.messages as Array<{ role: string; content: string }>)
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
  );
  expect(users).toEqual([
    ['initial'],
    ['initial', 'steering'],
    ['initial', 'steering', 'follow-up'],
  ]);
});
for (const decision of ['allow', 'deny', 'abort'] as const)
  it(`awaits host approval ${decision} before executing tools`, async () => {
    const fixture = await protocolFixture('openai-completions', { tool: 'approved' });
    cleanups.push(fixture.close);
    const c = setup('openai-completions', fixture.endpoint);
    const execute = vi.fn(async () => ({ content: [] }));
    c.registry.register({
      name: 'approved',
      description: 'Approved tool',
      schema: { type: 'object' },
      initialLoad: true,
      execute,
    });
    c.approve = vi.fn(async () =>
      decision === 'abort' ? new Promise<'allow'>(() => {}) : decision
    );
    const doe = new Doe(c);
    const pending = doe.run('approve');
    await vi.waitFor(() => expect(c.approve).toHaveBeenCalled());
    if (decision === 'abort') doe.abort();
    const result = await pending;
    expect(execute).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
    expect(result.stopReason).toBe(decision === 'abort' ? 'aborted' : 'stop');
    expect(result.approvalDenied).toBe(decision === 'deny' ? true : undefined);
  });
it('abort cancels a running tool and a waiting credentials callback', async () => {
  const fixture = await protocolFixture('openai-completions', { tool: 'slow' });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  let signal: AbortSignal | undefined;
  c.registry.register({
    name: 'slow',
    description: 'Slow tool',
    schema: { type: 'object' },
    initialLoad: true,
    execute: async (_args, ctx) => {
      signal = ctx.signal;
      return new Promise(() => {});
    },
  });
  const doe = new Doe(c);
  const pending = doe.run('slow');
  await vi.waitFor(() => expect(signal).toBeDefined());
  doe.abort();
  expect((await pending).stopReason).toBe('aborted');
  expect(signal?.aborted).toBe(true);
  c.model.credentials = vi.fn(() => new Promise<string | undefined>(() => {}));
  const waiting = doe.run('auth');
  await vi.waitFor(() => expect(c.model.credentials).toHaveBeenCalled());
  doe.abort();
  expect((await waiting).stopReason).toBe('aborted');
});
it('persistence failure before message completion rejects the original error without success', async () => {
  const fixture = await protocolFixture('openai-completions');
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  const original = c.store.appendMessage.bind(c.store);
  vi.spyOn(c.store, 'appendMessage').mockImplementation((id, message, scope) => {
    if (message.role === 'assistant') throw new Error('message disk failure');
    return original(id, message, scope);
  });
  const events: DoeEvent[] = [];
  c.onEvent = (e) => events.push(e);
  await expect(new Doe(c).run('persist')).rejects.toThrow('message disk failure');
  expect(events.some((e) => e.type === 'complete')).toBe(false);
});
it('usage persistence failure rejects the original error without success', async () => {
  const fixture = await protocolFixture('openai-completions');
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  vi.spyOn(c.store, 'recordUsage').mockImplementation(() => {
    throw new Error('usage disk failure');
  });
  await expect(new Doe(c).run('persist')).rejects.toThrow('usage disk failure');
});
it('retries transient requests with unique usage and same-payer compatible fallbacks only', async () => {
  const primary = await protocolFixture('openai-completions', { statuses: [503, 200] });
  const fallback = await protocolFixture('openai-completions');
  cleanups.push(primary.close, fallback.close);
  const c = setup('openai-completions', primary.endpoint);
  c.retry = { maxAttempts: 2, delayMs: () => 0 };
  const result = await new Doe(c).run('retry');
  expect(result.stopReason).toBe('stop');
  expect(primary.requests()).toBe(2);
  expect(result.usage).toHaveLength(2);
  expect(
    c.store.archive('test').filter((record) => record.payload.role === 'assistant')
  ).toHaveLength(2);
  expect(new Set(result.usage.map((u) => u.requestId)).size).toBe(2);
  const down = await protocolFixture('openai-completions', { status: 503 });
  cleanups.push(down.close);
  c.model.endpoint = down.endpoint;
  c.retry = {
    maxAttempts: 1,
    delayMs: () => 0,
    fallbacks: [{ ...c.model, endpoint: fallback.endpoint, id: 'fallback' }],
  };
  const events: DoeEvent[] = [];
  c.onEvent = (e) => events.push(e);
  expect((await new Doe(c).run('fallback')).stopReason).toBe('stop');
  expect(fallback.requests()).toBe(1);
  expect(events.some((e) => e.type === 'substitution')).toBe(true);
  for (const change of [
    { payer: 'other' },
    { historyFamily: 'other' },
    { protocol: 'openai-responses' as const },
  ]) {
    c.retry.fallbacks = [{ ...c.model, endpoint: fallback.endpoint, ...change }];
    expect((await new Doe(c).run('refuse')).stopReason).toBe('error');
  }
  expect(fallback.requests()).toBe(1);
});
for (const status of [401, 429])
  it(`${status} auth/quota refuses retry and fallback and hides echoed credentials`, async () => {
    const primary = await protocolFixture('openai-completions', {
      status,
      errorMessage: 'explicit-fixture secret echoed',
    });
    const fallback = await protocolFixture('openai-completions');
    cleanups.push(primary.close, fallback.close);
    const c = setup('openai-completions', primary.endpoint);
    c.retry = {
      maxAttempts: 3,
      delayMs: () => 0,
      fallbacks: [{ ...c.model, endpoint: fallback.endpoint }],
    };
    const result = await new Doe(c).run('refuse');
    expect(result.stopReason).toBe('error');
    expect(primary.requests()).toBe(1);
    expect(fallback.requests()).toBe(0);
    expect(JSON.stringify(c.store.archive('test'))).not.toContain('explicit-fixture');
    expect(result.usage[0]?.inputTokens).toBeUndefined();
  });
it('never replays after emitted text or an executed tool', async () => {
  const streamed = await protocolFixture('openai-completions', { afterTextError: true });
  cleanups.push(streamed.close);
  const c = setup('openai-completions', streamed.endpoint);
  c.retry = { maxAttempts: 3, delayMs: () => 0 };
  const events: DoeEvent[] = [];
  c.onEvent = (e) => events.push(e);
  const result = await new Doe(c).run('stream');
  expect(result.stopReason).toBe('error');
  expect(events.some((e) => e.type === 'text')).toBe(true);
  expect(streamed.requests()).toBe(1);
  const tool = await protocolFixture('openai-completions', {
    tool: 'effect',
    statuses: [200, 503],
  });
  cleanups.push(tool.close);
  c.model.endpoint = tool.endpoint;
  const execute = vi.fn(async () => ({ content: [] }));
  c.registry.register({
    name: 'effect',
    description: 'Effect',
    schema: { type: 'object' },
    initialLoad: true,
    execute,
  });
  expect((await new Doe(c).run('effect')).stopReason).toBe('error');
  expect(execute).toHaveBeenCalledTimes(1);
  expect(tool.requests()).toBe(2);
});
it('refreshes nested instruction context before the next provider request without allowing same-batch mutation', async () => {
  const { mkdtemp, mkdir, writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { LocalResources } = await import('../resources/resources.js');
  const { createLocalTools } = await import('../tools/local.js');
  const root = await mkdtemp(join(tmpdir(), 'doe-live-rules-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'nested'));
  await writeFile(join(root, 'nested/AGENTS.md'), 'NESTED FORMAT RULE');
  await writeFile(join(root, 'nested/data'), 'before');
  const fixture = await protocolFixture('openai-completions', { tool: 'write' });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  c.workingDirectory = root;
  c.pathPolicy = { readRoots: [root], writeRoots: [root] };
  c.resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    c.pathPolicy,
    root
  );
  const write = createLocalTools({
    resources: c.resources,
    pathPolicy: c.pathPolicy,
    workingDirectory: root,
  }).find((t) => t.name === 'write')!;
  c.registry.register({
    ...write,
    schema: { type: 'object' },
    execute: (_args, ctx) => write.execute({ path: 'nested/data', content: 'after' }, ctx),
  });
  expect((await new Doe(c).run('write')).stopReason).toBe('stop');
  expect(JSON.stringify(fixture.bodies[1])).toContain('NESTED FORMAT RULE');
  expect(await readFile(join(root, 'nested/data'), 'utf8')).toBe('before');
});
it('beat finishTurn ends after the complete current tool batch with separate context and usage', async () => {
  const fixture = await protocolFixture('openai-completions', { tool: 'end_beat' });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  let finished = false;
  c.extensions = {
    runBeat: async (request, ctx) => {
      const result = await ctx.execute({
        prompt: 'BEAT ONLY',
        messages: [{ role: 'user', content: request.prompt, timestamp: 1 }],
        tools: [
          {
            name: 'end_beat',
            description: 'End beat',
            schema: { type: 'object' },
            execute: async () => {
              finished = true;
              return { content: [] };
            },
          },
        ],
        scope: ctx.scope,
        purpose: 'beat',
        finishTurn: async (messages) => {
          expect(messages.some((m) => m.role === 'toolResult')).toBe(true);
          return finished ? 'end' : 'continue';
        },
      });
      expect(result.usage).toHaveLength(1);
      return { kind: 'quiet' };
    },
  };
  expect(await new Doe(c).runBeat({ id: 'one', prompt: 'beat' })).toEqual({ kind: 'quiet' });
  expect(fixture.requests()).toBe(1);
  expect(c.store.archive('test')).toEqual([]);
  expect(c.store.archive('test', 'beat:one').some((r) => r.payload.role === 'toolResult')).toBe(
    true
  );
});
it('import, construction and discovery stay offline and configured requests stay inside the supplied destination', async () => {
  const spy = vi.spyOn(globalThis, 'fetch');
  const c = setup('openai-completions', 'http://localhost:1/v1');
  const { PiEngine } = await import('../pi-engine.js');
  new PiEngine();
  new Doe(c);
  c.registry.search('absent');
  await c.resources.skills();
  expect(spy).not.toHaveBeenCalled();
  const fixture = await protocolFixture('openai-completions');
  cleanups.push(fixture.close);
  c.model.endpoint = fixture.endpoint;
  await new Doe(c).run('network');
  expect(spy.mock.calls.length).toBe(1);
  expect(String(spy.mock.calls[0]?.[0])).toBe(fixture.endpoint + '/chat/completions');
});

it('refreshes persisted business context across runs and facade reopen', async () => {
  const fixture = await protocolFixture('openai-completions');
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  let context = 'FIRST-CONTEXT';
  c.resources.load = async () => context;
  const doe = new Doe(c);
  await doe.run('one');
  context = 'SECOND-CONTEXT';
  await doe.run('two');
  context = 'THIRD-CONTEXT';
  await new Doe(c).run('three');
  expect(JSON.stringify(fixture.bodies[1])).toContain('SECOND-CONTEXT');
  expect(JSON.stringify(fixture.bodies[2])).toContain('THIRD-CONTEXT');
});
for (const protocol of ['anthropic-messages', 'openai-completions', 'openai-responses'] as const)
  it(`${protocol} redacts successful credential echoes including split text deltas while preserving opaque fields`, async () => {
    const fixture = await protocolFixture(protocol, {
      textChunks: ['safe ', 'sentinel-', 'secret', ' tail'],
    });
    cleanups.push(fixture.close);
    const c = setup(protocol, fixture.endpoint);
    c.model.credentials = async () => 'sentinel-secret';
    const events: DoeEvent[] = [];
    c.onEvent = (e) => events.push(e);
    const result = await new Doe(c).run('hello');
    expect(JSON.stringify(events)).not.toContain('sentinel-secret');
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => ('delta' in e ? e.delta : ''))
        .join('')
    ).not.toContain('sentinel-secret');
    expect(JSON.stringify(c.store.archive('test'))).not.toContain('sentinel-secret');
    expect(JSON.stringify(result)).toContain('[redacted credential]');
    expect(JSON.stringify(result)).toContain('safe ');
  });
it('refuses malformed host approval rather than executing an effect', async () => {
  const fixture = await protocolFixture('openai-completions', { tool: 'effect' });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  const execute = vi.fn(async () => ({ content: [{ type: 'text' as const, text: 'done' }] }));
  c.registry.register({
    name: 'effect',
    description: 'Effect',
    initialLoad: true,
    schema: { type: 'object', properties: {} },
    execute,
  });
  c.approve = (async () => undefined) as unknown as NonNullable<DoeConfig['approve']>;
  await new Doe(c).run('do');
  expect(execute).not.toHaveBeenCalled();
});

it('redacts split thinking and successful tool output without dropping opaque nonsecret fields', async () => {
  const fixture = await protocolFixture('openai-completions', {
    tool: 'echo',
    thinkingChunks: ['sentinel-', 'secret'],
  });
  cleanups.push(fixture.close);
  const c = setup('openai-completions', fixture.endpoint);
  c.model.credentials = async () => 'sentinel-secret';
  const events: DoeEvent[] = [];
  c.onEvent = (e) => events.push(e);
  c.registry.register({
    name: 'echo',
    description: 'Echo',
    initialLoad: true,
    schema: { type: 'object', properties: {} },
    execute: async (_args, ctx) => {
      ctx.emit({
        type: 'tool-progress',
        scope: ctx.scope,
        name: 'echo',
        callId: ctx.callId!,
        progress: 'sentinel-secret',
      });
      return {
        content: [{ type: 'text', text: 'sentinel-secret' }],
        structuredContent: { opaque: 'keep-this' },
      };
    },
  });
  const result = await new Doe(c).run('go');
  expect(
    events
      .filter((e) => e.type === 'thinking')
      .map((e) => ('delta' in e ? e.delta : ''))
      .join('')
  ).not.toContain('sentinel-secret');
  expect(JSON.stringify(events)).not.toContain('sentinel-secret');
  expect(JSON.stringify(result)).not.toContain('sentinel-secret');
  expect(JSON.stringify(c.store.archive('test'))).not.toContain('sentinel-secret');
  expect(JSON.stringify(result)).toContain('keep-this');
});

for (const callback of ['credentials', 'tool'] as const)
  it(`${callback} callback aborting and rejecting never leaves an unhandled host promise`, async () => {
    const fixture = await protocolFixture(
      'openai-completions',
      callback === 'tool' ? { tool: 'effect' } : {}
    );
    cleanups.push(fixture.close);
    const c = setup('openai-completions', fixture.endpoint);
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    cleanups.push(() => {
      process.off('unhandledRejection', unhandled);
    });
    const doe = new Doe(c);
    const rejected = async () => {
      doe.abort();
      throw new Error('host callback aborted');
    };
    if (callback === 'credentials') c.model.credentials = rejected;
    else
      c.registry.register({
        name: 'effect',
        description: 'Effect',
        initialLoad: true,
        schema: { type: 'object', properties: {} },
        execute: rejected,
      });
    expect((await doe.run('go')).stopReason).toBe('aborted');
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  });
