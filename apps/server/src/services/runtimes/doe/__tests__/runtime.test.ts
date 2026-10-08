import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import {
  makeRuntime,
  engine,
  drain,
  projectDir,
  requests,
  collect,
  inference,
  model,
} from './runtime-fixture.js';

it('constructs and lists metadata without resolving model authentication', async () => {
  const resolveModel = vi.fn();
  const runtime = makeRuntime({ resolveModel });
  runtime.ensureSession('cold', { cwd: projectDir, permissionMode: 'default' });
  expect(await runtime.listSessions(projectDir)).toHaveLength(1);
  expect(resolveModel).not.toHaveBeenCalled();
  expect(runtime.getCapabilities()).toBe(runtime.getCapabilities());
});
it('RT-SES-04: streams the real facade output, durable provider usage and one terminal', async () => {
  const runtime = makeRuntime();
  const events = await drain(runtime, 'ordinary');
  expect((await runtime.getSession(projectDir, 'ordinary'))?.id).toBe('ordinary');
  expect(runtime.sessions.models.archive('ordinary').length).toBeGreaterThan(0);
  expect(
    events.filter((e) => e.type === 'text_delta').map((e) => (e.data as { text: string }).text)
  ).toEqual(['Finished.']);
  expect(events.filter((e) => e.type === 'done')).toHaveLength(1);
  expect(await runtime.readContextUsage('ordinary')).toEqual({
    contextTokens: 100,
    contextMaxTokens: 200000,
  });
  expect(runtime.sessions.models.archive('ordinary').at(-1)?.payload.content).toBe('Finished.');
});
it('refuses absent inference explicitly and never substitutes ambient credentials', async () => {
  const resolveModel = vi.fn();
  const runtime = makeRuntime({ inference: () => null, resolveModel });
  const events = await drain(runtime);
  expect(events.some((e) => e.type === 'error')).toBe(true);
  expect(events.at(-1)?.type).toBe('done');
  expect(resolveModel).not.toHaveBeenCalled();
});
it('reserves the turn before asynchronous settings hydration and stops setup ownership', async () => {
  const runtime = makeRuntime();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.setSessionSettings({
    getSessionSettings: async () => {
      await held;
      return null;
    },
    saveSessionSettings: async () => {},
    rekeySessionSettings: async () => {},
  });
  runtime.ensureSession('race', { cwd: projectDir, permissionMode: 'default' });
  const first = runtime.sendMessage('race', 'One');
  const reading = first.next();
  expect(runtime.isTurnOpen('race')).toBe(true);
  await expect(runtime.sendMessage('race', 'Two').next()).rejects.toThrow('running turn');
  const stop = runtime.interruptQuery('race');
  release();
  expect((await stop).outcome).toBe('acked');
  await reading;
  await first.return(undefined);
  expect(runtime.isTurnOpen('race')).toBe(false);
});
it('reports unconfirmed stop while an engine still owns work and drains after release', async () => {
  let release!: () => void;
  let entered = false;
  const runtime = makeRuntime({
    interruptWaitMs: 5,
    engineFactory: () =>
      engine(async (request) => {
        entered = true;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        return { messages: [], scope: request.context.scope, stopReason: 'aborted' };
      }),
  });
  const id = randomUUID();
  runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
  const stream = runtime.sendMessage(id, 'Wait');
  const pending = stream.next();
  await vi.waitFor(() => expect(entered).toBe(true));
  expect(await runtime.interruptQuery(id)).toEqual({
    outcome: 'unconfirmed',
    reason: 'ack-timeout',
    runtime: 'doe',
  });
  expect(runtime.isTurnOpen(id)).toBe(true);
  release();
  await pending;
  await stream.return(undefined);
  expect(runtime.isTurnOpen(id)).toBe(false);
});
it('refreshes system context each turn without mutating the person’s message', async () => {
  const runtime = makeRuntime();
  const id = randomUUID();
  runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
  const before = requests.length;
  await collect(runtime.sendMessage(id, 'First', { systemPromptAppend: 'CONTEXT_A' }));
  await collect(runtime.sendMessage(id, 'Second', { systemPromptAppend: 'CONTEXT_B' }));
  expect(requests[before]?.prompt).toContain('CONTEXT_A');
  expect(requests[before + 1]?.prompt).toContain('CONTEXT_B');
  expect(requests[before + 1]?.prompt).not.toContain('CONTEXT_A');
  expect(
    runtime.sessions.models
      .archive(id)
      .filter((r) => r.payload.role === 'user')
      .map((r) => r.payload.content)
  ).toEqual(['First', 'Second']);
});

it('does not restore stale autonomy after a settings update finishes during hydration', async () => {
  const runtime = makeRuntime();
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  runtime.ensureSession('settings-race', { cwd: projectDir, permissionMode: 'bypassPermissions' });
  runtime.setSessionSettings({
    getSessionSettings: async () => {
      await held;
      return { permissionMode: 'bypassPermissions' };
    },
    saveSessionSettings: async () => {},
    rekeySessionSettings: async () => {},
  });
  const stream = runtime.sendMessage('settings-race', 'Work');
  const pending = stream.next();
  expect(await runtime.updateSession('settings-race', { permissionMode: 'default' })).toEqual({
    updated: true,
    permissionModePendingUntilNextTurn: true,
  });
  release();
  await pending;
  await collect(stream);
  expect(runtime.sessions.get('settings-race')?.session.permissionMode).toBe('default');
});

it('freezes a conversation payer while new conversations follow an explicit source change', async () => {
  let source: 'local' | 'dorkos-credits' = 'local';
  const runtime = makeRuntime({ inference: () => ({ ...inference, source }) });
  await drain(runtime, 'frozen-own');
  source = 'dorkos-credits';
  expect(await runtime.sessionRunsOnCredits('frozen-own')).toBe(false);
  expect(await runtime.sessionRunsOnCredits('new-credit')).toBe(true);
  await drain(runtime, 'frozen-own');
  expect(runtime.sessions.get('frozen-own')?.inference).toMatchObject({ source: 'local' });
});

it('ends and releases a turn even when its terminal metadata write fails', async () => {
  const runtime = makeRuntime();
  const update = runtime.sessions.update.bind(runtime.sessions);
  vi.spyOn(runtime.sessions, 'update').mockImplementation((id, patch) => {
    if (Object.keys(patch).length === 0) throw new Error('SQLite terminal write failed');
    return update(id, patch);
  });
  const events = await drain(runtime, 'failed-terminal');
  expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  expect(events.some((event) => event.type === 'error')).toBe(true);
  expect(runtime.isTurnOpen('failed-terminal')).toBe(false);
  expect((await runtime.interruptQuery('failed-terminal')).outcome).toBe('not-running');
});

it('reports the resolved model context limit rather than stale setup metadata', async () => {
  const runtime = makeRuntime({ resolveModel: async () => ({ ...model, contextWindow: 8192 }) });
  await drain(runtime, 'actual-context');
  expect(await runtime.readContextUsage('actual-context')).toEqual({
    contextTokens: 100,
    contextMaxTokens: 8192,
  });
});

it('keeps a frozen local conversation model menu after global service changes', async () => {
  let configuration = inference;
  const runtime = makeRuntime({ inference: () => configuration });
  await drain(runtime, 'frozen-menu');
  configuration = {
    ...inference,
    model: 'different-server-model',
    endpoint: 'http://localhost:2/v1',
  };
  expect((await runtime.getSupportedModels('frozen-menu')).map((option) => option.value)).toEqual([
    'local',
  ]);
  expect((await runtime.getSupportedModels()).map((option) => option.value)).toEqual([
    'different-server-model',
  ]);
});

it('ends a turn with unknown cumulative cost when its ledger read fails', async () => {
  const runtime = makeRuntime();
  vi.spyOn(runtime.sessions.models, 'costTotal').mockImplementation(() => {
    throw new Error('SQLite ledger read failed');
  });
  const events = await drain(runtime, 'failed-cost');
  expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  const terminal = events.find(
    (event) => event.type === 'session_status' && 'terminalReason' in event.data
  );
  expect(terminal?.data).toMatchObject({ terminalReason: 'completed', turnCostUsd: 0.01 });
  expect(terminal?.data).not.toHaveProperty('costUsd');
  expect(runtime.isTurnOpen('failed-cost')).toBe(false);
  expect((await runtime.interruptQuery('failed-cost')).outcome).toBe('not-running');
});

it('preserves tightened session settings while model resolution is pending', async () => {
  let release!: () => void;
  let entered = false;
  const runtime = makeRuntime({
    resolveModel: async () => {
      entered = true;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { ...model, contextWindow: 8192 };
    },
  });
  runtime.ensureSession('model-settings-race', {
    cwd: projectDir,
    permissionMode: 'bypassPermissions',
  });
  const running = collect(runtime.sendMessage('model-settings-race', 'Work'));
  await vi.waitFor(() => expect(entered).toBe(true));
  await runtime.updateSession('model-settings-race', {
    permissionMode: 'default',
    model: 'changed',
  });
  release();
  await running;
  expect(runtime.sessions.get('model-settings-race')?.session).toMatchObject({
    permissionMode: 'default',
    model: 'changed',
  });
  expect(await runtime.readContextUsage('model-settings-race')).toMatchObject({
    contextMaxTokens: 8192,
  });
});

it('reports a looser active permission mode as applying on the next turn', async () => {
  let entered = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = makeRuntime({
    engineFactory: () =>
      engine(async (request) => {
        entered = true;
        await held;
        return { messages: [], scope: request.context.scope, stopReason: 'stop' };
      }),
  });
  runtime.ensureSession('looser-mode', { cwd: projectDir, permissionMode: 'default' });
  const running = collect(runtime.sendMessage('looser-mode', 'Work'));
  await vi.waitFor(() => expect(entered).toBe(true));
  let outcome;
  try {
    outcome = await runtime.updateSession('looser-mode', { permissionMode: 'bypassPermissions' });
  } finally {
    release();
    await running;
  }
  expect(outcome).toEqual({ updated: true, permissionModePendingUntilNextTurn: true });
});
