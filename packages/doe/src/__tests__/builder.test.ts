import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, realpath, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { createBuilderTool, createBuilderShell } from '../builder.js';
import { LocalResources } from '../resources/resources.js';
import { Doe } from '../doe.js';
import { SqliteModelStore } from '../store.js';
import { DeferredToolRegistry } from '../registry/registry.js';
import type { ToolContext, DoeConfig } from '../contracts.js';
import type { Engine, EngineRequest } from '../engine.js';
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doe-builder-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const pathPolicy = { readRoots: [root], writeRoots: [root] };
  const resources = new LocalResources(
    { ancestorDirectories: [root], skillRoots: [] },
    pathPolicy,
    root
  );
  return {
    workingDirectory: root,
    resources,
    pathPolicy,
    maxResultCharacters: 50,
    maxDurationMs: 1000,
    maxOutputBytes: 200,
  };
}
function context(root: string, signal = new AbortController().signal): ToolContext {
  return { sessionId: 'test', scope: 'main', workingDirectory: root, signal, emit: () => {} };
}
function command(script: string) {
  return `${JSON.stringify(process.execPath)} -e '${script.replaceAll("'", "'\\''")}'`;
}
it('creates a curated child with coding guidance, distinct resources, no recursive discovery and bounded final text', async () => {
  const options = await fixture();
  const events: unknown[] = [];
  let captured: unknown;
  const c = context(options.workingDirectory);
  c.emit = (e) => events.push(e);
  c.execute = async (o) => {
    captured = o;
    return {
      stopReason: 'stop',
      usage: [],
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(100) }] }],
    };
  };
  const builder = createBuilderTool({
    ...options,
    guidance: 'HOST-MINI-APP',
    tools: [
      {
        name: 'custom',
        description: 'custom',
        schema: { type: 'object' },
        execute: async () => ({ content: [] }),
      },
    ],
  });
  const result = await builder.execute({ task: 'Build an app' }, c);
  expect(JSON.stringify(captured)).toContain('HOST-MINI-APP');
  const o = captured as Parameters<NonNullable<ToolContext['execute']>>[0];
  expect(o.prompt).toContain('coding');
  expect(o.resources).toBe(options.resources);
  expect(o.registry!.selected().map((t) => t.name)).toEqual(
    expect.arrayContaining(['read', 'write', 'edit', 'search', 'shell', 'tool_search'])
  );
  expect(o.registry!.search('custom', 1).map((t) => t.name)).toContain('custom');
  expect(o.registry!.search('builder', 8).map((t) => t.name)).not.toContain('builder');
  expect(JSON.stringify(result)).not.toContain('x'.repeat(51));
  expect(o.scope).toMatch(/^child:/);
});
it('rejects builder recursion, main discovery bindings and malformed or failed child results', async () => {
  const o = await fixture();
  for (const name of ['builder', 'tool_search'])
    expect(() =>
      createBuilderTool({
        ...o,
        tools: [
          {
            name,
            description: 'bad',
            schema: { type: 'object' },
            execute: async () => ({ content: [] }),
          },
        ],
      })
    ).toThrow();
  const b = createBuilderTool(o);
  expect((await b.execute({ task: 'x' }, context(o.workingDirectory))).isError).toBe(true);
  for (const stopReason of ['aborted', 'error', 'length'] as const) {
    const c = context(o.workingDirectory);
    c.execute = async () => ({
      stopReason,
      usage: [],
      messages: [{ role: 'assistant', content: 'false success' }],
    });
    expect((await b.execute({ task: 'x' }, c)).isError).toBe(true);
  }
  expect((await b.execute({ task: '' }, context(o.workingDirectory))).isError).toBe(true);
  const nested = context(o.workingDirectory);
  nested.scope = 'child:recursive';
  nested.execute = async () => {
    throw new Error('must not launch');
  };
  expect(JSON.stringify(await b.execute({ task: 'nested' }, nested))).toContain('Recursive');
});
it.skipIf(process.platform === 'win32')(
  'shell refuses missing policy and never inherits ambient secrets',
  async () => {
    const o = await fixture();
    expect(
      (await createBuilderShell(o).execute({ command: 'echo x' }, context(o.workingDirectory)))
        .isError
    ).toBe(true);
    vi.stubEnv('DOE_BUILDER_SECRET', 'ambient-secret');
    try {
      const shell = createBuilderShell({
        ...o,
        executionPolicy: { kind: 'unrestricted', environment: { VISIBLE: 'approved' } },
      });
      const r = await shell.execute(
        {
          command: command(
            'console.log(JSON.stringify({visible:process.env.VISIBLE,secret:process.env.DOE_BUILDER_SECRET}))'
          ),
        },
        context(o.workingDirectory)
      );
      expect(JSON.stringify(r)).toContain('approved');
      expect(JSON.stringify(r)).not.toContain('ambient-secret');
      expect(r.isError).not.toBe(true);
    } finally {
      vi.unstubAllEnvs();
    }
  }
);
it('isolated executor receives explicit bounds, empty env and cancellation; oversized returned output stays bounded', async () => {
  const o = await fixture();
  let request: unknown;
  const execute = vi.fn(async (r) => {
    request = r;
    return { stdout: 'a'.repeat(1000), stderr: 'b'.repeat(1000), exitCode: 0, truncated: false };
  });
  const shell = createBuilderShell({ ...o, executionPolicy: { kind: 'isolated', execute } });
  const c = context(o.workingDirectory);
  const result = await shell.execute({ command: 'test' }, c);
  expect(request).toMatchObject({
    cwd: await realpath(o.workingDirectory),
    environment: {},
    timeoutMs: 1000,
    maxOutputBytes: 200,
  });
  expect(JSON.stringify(result)).not.toContain('a'.repeat(201));
  expect(result.structuredContent).toMatchObject({ truncated: true });
});
it.skipIf(process.platform === 'win32')(
  'shell bounds output and duration, cancels only its owned process and refuses excess concurrent work',
  async () => {
    const o = await fixture();
    const shell = createBuilderShell({
      ...o,
      maxDurationMs: 1000,
      executionPolicy: { kind: 'unrestricted', environment: {} },
    });
    const overflow = await shell.execute(
      { command: command('process.stdout.write("x".repeat(10000));setInterval(()=>{},1000)') },
      context(o.workingDirectory)
    );
    expect(overflow.isError).toBe(true);
    expect(JSON.stringify(overflow)).not.toContain('x'.repeat(201));
    const marker = join(o.workingDirectory, 'started');
    const ac = new AbortController();
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {} });
    cleanups.push(() => {
      unrelated.kill();
    });
    const running = shell.execute(
      {
        command: command(
          `require("fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`
        ),
      },
      context(o.workingDirectory, ac.signal)
    );
    await vi.waitFor(() => expect(readFile(marker, 'utf8')).resolves.toBeTruthy());
    expect(
      (await shell.execute({ command: 'echo extra' }, context(o.workingDirectory))).isError
    ).toBe(true);
    ac.abort();
    expect((await running).isError).toBe(true);
    expect(unrelated.exitCode).toBeNull();
    expect(unrelated.killed).toBe(false);
    const timeout = await createBuilderShell({
      ...o,
      maxDurationMs: 200,
      executionPolicy: { kind: 'unrestricted', environment: {} },
    }).execute({ command: command('setInterval(()=>{},1000)') }, context(o.workingDirectory));
    expect(timeout.isError).toBe(true);
    expect(JSON.stringify(timeout)).toContain('duration');
  }
);
it('child local tools retain canonical grants and unique-edit requirements', async () => {
  const o = await fixture();
  await writeFile(join(o.workingDirectory, 'text'), 'twice twice');
  const foreign = await fixture();
  await writeFile(join(foreign.workingDirectory, 'secret'), 'OUTSIDE');
  await symlink(foreign.workingDirectory, join(o.workingDirectory, 'link'));
  const c = context(o.workingDirectory);
  c.execute = async (request) => {
    const tools = request.registry!.selected();
    for (const [name, args] of [
      ['read', { path: '../escape' }],
      ['read', { path: 'link/secret' }],
      ['edit', { path: 'text', oldText: 'twice', newText: 'once' }],
    ] as const)
      expect((await tools.find((t) => t.name === name)!.execute(args, c)).isError).toBe(true);
    return { stopReason: 'stop', usage: [], messages: [{ role: 'assistant', content: 'Checked' }] };
  };
  expect((await createBuilderTool(o).execute({ task: 'Check' }, c)).isError).not.toBe(true);
});
it('facade child persists separate history and counts usage once with inherited payer and tagged progress', async () => {
  const o = await fixture();
  const store = new SqliteModelStore(join(o.workingDirectory, 'model.sqlite'));
  cleanups.push(() => store.close());
  const registry = new DeferredToolRegistry();
  registry.register(createBuilderTool(o));
  const events: unknown[] = [];
  const c: DoeConfig = {
    sessionId: 'test',
    workingDirectory: o.workingDirectory,
    store,
    registry,
    resources: new LocalResources(
      { ancestorDirectories: [], skillRoots: [] },
      o.pathPolicy,
      o.workingDirectory
    ),
    pathPolicy: o.pathPolicy,
    model: {
      id: 'local',
      protocol: 'openai-completions',
      endpoint: 'http://127.0.0.1/v1',
      payer: 'explicit',
      historyFamily: 'local',
      contextWindow: 1000,
      maxOutputTokens: 100,
      credentials: async () => undefined,
    },
    onEvent: (e) => events.push(e),
  };
  let scope = '';
  const factory = (): Engine => ({
    run: async (r: EngineRequest) => {
      if (r.context.scope === 'main') {
        const result = await r.tools
          .find((t) => t.name === 'builder')!
          .execute({ task: 'Build' }, r.context);
        expect(result.isError).not.toBe(true);
      } else {
        scope = r.context.scope;
        expect(r.model.payer).toBe('explicit');
        r.context.emit({ type: 'text', scope: r.context.scope, delta: 'child-progress' });
        await r.onMessage({ role: 'assistant', content: 'child-final' });
        await r.onUsage({ requestId: 'child-request', inputTokens: 2, outputTokens: 3 });
      }
      return {
        messages: [
          { role: 'assistant', content: r.context.scope === 'main' ? 'parent' : 'child-final' },
        ],
        usage: [],
        stopReason: 'stop',
        scope: r.context.scope,
      };
    },
    abort() {},
    steer() {
      return 'idle';
    },
    followUp() {
      return 'idle';
    },
  });
  await new Doe(c, factory).run('run');
  expect(JSON.stringify(store.archive('test'))).not.toContain('child-final');
  expect(JSON.stringify(store.archive('test', scope as `child:${string}`))).toContain(
    'child-final'
  );
  expect(store.allUsage('test')).toHaveLength(1);
  expect(events).toContainEqual(expect.objectContaining({ scope, delta: 'child-progress' }));
});
it('parent cancellation and child deadline settle blocked execution without a success summary', async () => {
  const o = await fixture();
  for (const trigger of ['parent', 'deadline']) {
    const ac = new AbortController();
    const c = context(o.workingDirectory, ac.signal);
    let signal: AbortSignal | undefined;
    c.execute = async (request) => {
      signal = request.signal;
      return new Promise(() => {});
    };
    const pending = createBuilderTool({ ...o, maxDurationMs: 100 }).execute({ task: 'wait' }, c);
    await vi.waitFor(() => expect(signal).toBeDefined());
    if (trigger === 'parent') ac.abort();
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(signal!.aborted).toBe(true);
  }
});
it('real child Pi honors host approval and parent abort of waiting approval', async () => {
  const { protocolFixture } = await import('./protocol-fixture.js');
  const { PiEngine } = await import('../pi-engine.js');
  for (const decision of ['allow', 'deny', 'abort'] as const) {
    const o = await fixture();
    const wire = await protocolFixture('openai-completions', { tool: 'effect' });
    cleanups.push(wire.close);
    const store = new SqliteModelStore(':memory:');
    cleanups.push(() => store.close());
    const effect = vi.fn(async () => ({ content: [{ type: 'text', text: 'effect done' }] }));
    const registry = new DeferredToolRegistry();
    registry.register(
      createBuilderTool({
        ...o,
        maxDurationMs: 3000,
        tools: [
          {
            name: 'effect',
            description: 'effect',
            initialLoad: true,
            schema: { type: 'object', properties: {} },
            execute: effect,
          },
        ],
      })
    );
    let approval = false;
    const cfg: DoeConfig = {
      sessionId: 'approved',
      workingDirectory: o.workingDirectory,
      store,
      registry,
      resources: o.resources,
      pathPolicy: o.pathPolicy,
      model: {
        id: 'local',
        protocol: 'openai-completions',
        endpoint: wire.endpoint,
        payer: 'host',
        historyFamily: 'local',
        contextWindow: 10000,
        maxOutputTokens: 100,
        credentials: async () => (decision === 'deny' ? 'Host' : 'fixture-only'),
      },
      approve: async () => {
        approval = true;
        return decision === 'abort' ? new Promise(() => {}) : decision;
      },
    };
    let result;
    const factory = (): Engine => ({
      run: async (r) => {
        if (r.context.scope.startsWith('child:')) return new PiEngine().run(r);
        result = await r.tools[0].execute({ task: 'effect' }, r.context);
        return {
          messages: [],
          scope: r.context.scope,
          stopReason: r.signal.aborted ? 'aborted' : 'stop',
        };
      },
      abort() {},
      steer() {
        return 'idle';
      },
      followUp() {
        return 'idle';
      },
    });
    const doe = new Doe(cfg, factory);
    const pending = doe.run('start');
    await vi.waitFor(() => expect(approval).toBe(true));
    if (decision === 'abort') doe.abort();
    await pending;
    expect(effect).toHaveBeenCalledTimes(decision === 'allow' ? 1 : 0);
    if (decision !== 'allow') expect(result).toMatchObject({ isError: true });
  }
});
it('parent abort reaches the child shell process and isolated executor signal', async () => {
  const o = await fixture();
  for (const isolated of process.platform === 'win32' ? [true] : [false, true]) {
    const marker = join(o.workingDirectory, isolated ? 'isolated' : 'native');
    let executorSignal: AbortSignal | undefined;
    const policy = isolated
      ? {
          kind: 'isolated' as const,
          execute: async (request: import('../contracts.js').ExecutionRequest) => {
            executorSignal = request.signal;
            await writeFile(marker, 'ready');
            return new Promise<import('../contracts.js').ExecutionResult>(() => {});
          },
        }
      : { kind: 'unrestricted' as const, environment: {} };
    const registry = new DeferredToolRegistry();
    registry.register(createBuilderTool({ ...o, maxDurationMs: 3000, executionPolicy: policy }));
    const store = new SqliteModelStore(':memory:');
    cleanups.push(() => store.close());
    const cfg: DoeConfig = {
      sessionId: isolated ? 'iso' : 'native',
      workingDirectory: o.workingDirectory,
      store,
      registry,
      resources: o.resources,
      pathPolicy: o.pathPolicy,
      model: {
        id: 'fixture',
        protocol: 'openai-completions',
        endpoint: 'http://127.0.0.1/v1',
        historyFamily: 'fixture',
        payer: 'host',
        contextWindow: 1000,
        maxOutputTokens: 100,
        credentials: async () => undefined,
      },
    };
    const factory = (): Engine => ({
      run: async (r) => {
        if (r.context.scope === 'main') {
          await r.tools[0].execute({ task: 'run' }, r.context);
        } else {
          const shell = r.tools.find((t) => t.name === 'shell')!;
          const result = await shell.execute(
            {
              command: command(
                `require("fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)`
              ),
            },
            r.context
          );
          expect(result.isError).toBe(true);
        }
        return { messages: [], scope: r.context.scope, stopReason: 'aborted' };
      },
      abort() {},
      steer() {
        return 'idle';
      },
      followUp() {
        return 'idle';
      },
    });
    const doe = new Doe(cfg, factory);
    const run = doe.run('work');
    await vi.waitFor(() => expect(readFile(marker, 'utf8')).resolves.toBeTruthy(), {
      timeout: 2000,
    });
    const pid = isolated ? undefined : Number(await readFile(marker, 'utf8'));
    doe.abort();
    await run;
    if (isolated) expect(executorSignal!.aborted).toBe(true);
    else await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 2000 });
  }
});
it('refuses native Windows shell because direct process kill cannot bound descendant work', async () => {
  const o = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { ...descriptor, value: 'win32' });
    const result = await createBuilderShell({
      ...o,
      executionPolicy: { kind: 'unrestricted', environment: {} },
    }).execute({ command: 'echo test' }, context(o.workingDirectory));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).toContain('isolated executor');
  } finally {
    Object.defineProperty(process, 'platform', descriptor);
  }
});
it('actual child retries a nested-instruction refusal and then succeeds without treating recovery as denial', async () => {
  const { createServer } = await import('node:http');
  const { mkdir } = await import('node:fs/promises');
  const { PiEngine } = await import('../pi-engine.js');
  const o = await fixture();
  await mkdir(join(o.workingDirectory, 'nested'));
  await writeFile(join(o.workingDirectory, 'nested', 'AGENTS.md'), 'NESTED-RULE');
  let requests = 0;
  const bodies: unknown[] = [];
  const server = createServer(async (req, res) => {
    requests++;
    let body = '';
    for await (const chunk of req) body += chunk;
    bodies.push(JSON.parse(body));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (delta: unknown, finish_reason: string | null = null) =>
      res.write(
        `data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', created: 1, model: 'local', choices: [{ index: 0, delta, finish_reason }], usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } })}\n\n`
      );
    send({ role: 'assistant' });
    if (requests < 3)
      send({
        tool_calls: [
          {
            index: 0,
            id: `write${requests}`,
            type: 'function',
            function: {
              name: 'write',
              arguments: JSON.stringify({ path: 'nested/out', content: 'saved' }),
            },
          },
        ],
      });
    else send({ content: 'Saved and verified.' });
    send({}, requests < 3 ? 'tool_calls' : 'stop');
    res.end('data: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const address = server.address() as { port: number };
  const store = new SqliteModelStore(':memory:');
  cleanups.push(() => store.close());
  const registry = new DeferredToolRegistry();
  registry.register(createBuilderTool({ ...o, maxDurationMs: 3000 }));
  let result;
  const config: DoeConfig = {
    sessionId: 'retry',
    workingDirectory: o.workingDirectory,
    store,
    registry,
    resources: new LocalResources(
      { ancestorDirectories: [], skillRoots: [] },
      o.pathPolicy,
      o.workingDirectory
    ),
    pathPolicy: o.pathPolicy,
    model: {
      id: 'local',
      protocol: 'openai-completions',
      endpoint: `http://127.0.0.1:${address.port}/v1`,
      historyFamily: 'local',
      payer: 'host',
      contextWindow: 10000,
      maxOutputTokens: 100,
      credentials: async () => 'fixture-only',
    },
    approve: async () => 'allow',
  };
  const factory = (): Engine => ({
    run: async (request) => {
      if (request.context.scope.startsWith('child:')) return new PiEngine().run(request);
      result = await request.tools[0].execute({ task: 'Save nested file' }, request.context);
      return { messages: [], scope: request.context.scope, stopReason: 'stop' };
    },
    abort() {},
    steer() {
      return 'idle';
    },
    followUp() {
      return 'idle';
    },
  });
  await new Doe(config, factory).run('run');
  expect(requests).toBe(3);
  expect(JSON.stringify(bodies[1])).toContain('NESTED-RULE');
  expect(await readFile(join(o.workingDirectory, 'nested', 'out'), 'utf8')).toBe('saved');
  expect(result).not.toMatchObject({ isError: true });
});
it('bounds executor failures and child failures as well as successful output', async () => {
  const o = await fixture();
  const shell = createBuilderShell({
    ...o,
    executionPolicy: {
      kind: 'isolated',
      execute: async () => {
        throw Error('e'.repeat(1000));
      },
    },
  });
  const failed = await shell.execute({ command: 'fail' }, context(o.workingDirectory));
  expect(failed.isError).toBe(true);
  expect(JSON.stringify(failed)).not.toContain('e'.repeat(201));
  const c = context(o.workingDirectory);
  c.execute = async () => {
    throw Error('f'.repeat(1000));
  };
  const child = await createBuilderTool(o).execute({ task: 'fail' }, c);
  expect(child.isError).toBe(true);
  expect(JSON.stringify(child)).not.toContain('f'.repeat(51));
});
it('never treats an unknown or malformed policy as unrestricted authorization', async () => {
  const o = await fixture();
  for (const executionPolicy of [
    { kind: 'other' },
    { kind: 'unrestricted' },
    { kind: 'unrestricted', environment: null },
  ]) {
    const result = await createBuilderShell({
      ...o,
      executionPolicy: executionPolicy as never,
    }).execute({ command: 'echo unauthorized' }, context(o.workingDirectory));
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result)).not.toContain('unauthorized\n');
  }
});
it.skipIf(process.platform === 'win32')(
  'successful shell leader completion stops its redirected background descendants before releasing the slot',
  async () => {
    const o = await fixture();
    const marker = join(o.workingDirectory, 'background-pid');
    const shell = createBuilderShell({
      ...o,
      maxDurationMs: 1500,
      executionPolicy: { kind: 'unrestricted', environment: {} },
    });
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { env: {} });
    let pid: number | undefined;
    try {
      const result = await shell.execute(
        {
          command: `${command('setInterval(()=>{},1000)')} >/dev/null 2>&1 & echo $! > ${JSON.stringify(marker)}`,
        },
        context(o.workingDirectory)
      );
      expect(result.isError).not.toBe(true);
      pid = Number(await readFile(marker, 'utf8'));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      await vi.waitFor(() => expect(() => process.kill(pid!, 0)).toThrow(), { timeout: 1000 });
      expect(unrelated.killed).toBe(false);
      expect(unrelated.exitCode).toBeNull();
      expect(
        (await shell.execute({ command: 'echo next' }, context(o.workingDirectory))).isError
      ).not.toBe(true);
    } finally {
      if (pid)
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          expect((error as NodeJS.ErrnoException).code).toBe('ESRCH');
        }
      unrelated.kill();
    }
  }
);
