/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { StreamEvent } from '@dorkos/shared/types';
import type { DoeInferenceConfig } from '@dorkos/shared/config-schema';
import type { ToolDescriptor } from '@dorkos/doe';
import { protocolFixture } from '../../../../../../../packages/doe/src/__tests__/protocol-fixture.js';
import { DoeRuntime, type DoeRuntimeOptions } from '../doe-runtime.js';
import { resolveDoeInference } from '../credentials.js';
import { assembleDoeHost } from '../tools.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});
async function setup(
  protocol: Parameters<typeof protocolFixture>[0],
  wireOptions: Parameters<typeof protocolFixture>[1] = {},
  runtimeOptions: DoeRuntimeOptions = {},
  tool?: ToolDescriptor
) {
  const wire = await protocolFixture(protocol, wireOptions);
  cleanups.push(wire.close);
  const root = await realpath(await mkdtemp(join(tmpdir(), 'doe-runtime-wire-')));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const cwd = join(root, 'project');
  await mkdir(cwd);
  const config: DoeInferenceConfig = {
    source: 'local',
    provider: 'fixture',
    protocol: protocol === 'openai-completions' ? 'openai-chat-completions' : protocol,
    endpoint:
      protocol === 'anthropic-messages' ? wire.endpoint.replace(/\/v1$/, '') : wire.endpoint,
    model: 'fixture-model',
    contextWindow: 20000,
    maxOutputTokens: 100,
  };
  const credentials = {
    resolve: vi.fn(async () => ({
      ok: false as const,
      reason: 'unresolved' as const,
      ref: 'fixture',
      message: 'Fixture unavailable',
    })),
  };
  const options: DoeRuntimeOptions = {
    directory: join(root, 'runtime'),
    defaultCwd: cwd,
    inference: () => config,
    resolveModel: (input) => resolveDoeInference(input, { providers: () => ({}), credentials }),
    assembleHost: async (input) => {
      const host = await assembleDoeHost(input);
      if (tool) host.registry.register(tool);
      return host;
    },
    ...runtimeOptions,
  };
  const runtime = new DoeRuntime(options);
  cleanups.push(() => runtime.shutdown());
  const id = randomUUID();
  runtime.ensureSession(id, { cwd, permissionMode: 'default' });
  return { wire, runtime, id, config, options, credentials, cwd };
}
async function collect(source: AsyncIterable<StreamEvent>) {
  const events: StreamEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}
function text(events: StreamEvent[]) {
  return events
    .filter((event) => event.type === 'text_delta')
    .map((event) => (event.data as { text: string }).text)
    .join('');
}
function terminal(events: StreamEvent[]) {
  return events
    .filter((event) => event.type === 'session_status')
    .map(
      (event) =>
        event.data as {
          terminalReason?: string;
          turnInputTokens?: number;
          turnOutputTokens?: number;
        }
    )
    .find((data) => data.terminalReason);
}

describe('DoeRuntime actual SDK wire', () => {
  for (const protocol of [
    'anthropic-messages',
    'openai-completions',
    'openai-responses',
  ] as const) {
    it(`${protocol} streams local text and persists real provider usage through the facade`, async () => {
      const { runtime, wire, id, credentials } = await setup(protocol, {
        textChunks: ['first ', 'second'],
      });
      const events = await collect(runtime.sendMessage(id, 'Answer locally'));
      expect(text(events)).toBe('first second');
      expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
      expect(terminal(events)).toMatchObject({
        terminalReason: 'completed',
        turnInputTokens: 12,
        turnOutputTokens: 3,
      });
      expect(await runtime.readContextUsage(id)).toEqual({
        contextTokens: 12,
        contextMaxTokens: 20000,
      });
      expect(
        runtime.sessions.models.archive(id).some((record) => record.payload.role === 'assistant')
      ).toBe(true);
      expect(wire.requests()).toBe(1);
      expect(wire.paths).toEqual([
        protocol === 'anthropic-messages'
          ? '/v1/messages?beta=true'
          : protocol === 'openai-responses'
            ? '/v1/responses'
            : '/v1/chat/completions',
      ]);
      expect(credentials.resolve).not.toHaveBeenCalled();
      expect(runtime.isTurnOpen(id)).toBe(false);
    });
  }

  for (const approved of [true, false]) {
    it(`RT-TOOL-01: answers a live wire tool approval ${approved ? 'allow' : 'deny'} before executing its effect`, async () => {
      const effect = vi.fn(async () => ({ content: [{ type: 'text', text: 'executed-effect' }] }));
      const { runtime, wire, id } = await setup(
        'openai-completions',
        { tool: 'fixture_effect' },
        {},
        {
          name: 'fixture_effect',
          description: 'A fixture side effect',
          initialLoad: true,
          schema: { type: 'object', properties: {} },
          execute: effect,
        }
      );
      const events: StreamEvent[] = [];
      for await (const event of runtime.sendMessage(id, 'Perform the fixture action')) {
        events.push(event);
        if (event.type === 'approval_required') {
          expect(effect).not.toHaveBeenCalled();
          expect(runtime.approveTool(id, 'unrelated', approved)).toBe(false);
          const callId = (event.data as { toolCallId: string }).toolCallId;
          expect(runtime.approveTool(id, callId, approved)).toBe(true);
          expect(runtime.approveTool(id, callId, approved)).toBe(false);
        }
      }
      expect(events.filter((event) => event.type === 'approval_required')).toHaveLength(1);
      expect(effect).toHaveBeenCalledTimes(approved ? 1 : 0);
      expect(wire.requests()).toBe(2);
      const messages = wire.bodies[1]?.messages as Array<{ role: string; content: string }>;
      expect(messages.find((message) => message.role === 'tool')?.content).toContain(
        approved ? 'executed-effect' : 'Host refused tool approval'
      );
      expect(text(events)).toBe('hello');
      expect(terminal(events)?.terminalReason).toBe('completed');
    });
  }

  it('interrupts a parked live approval without executing the side effect or leaving a turn owner', async () => {
    const effect = vi.fn(async () => ({ content: [] }));
    const { runtime, id } = await setup(
      'openai-completions',
      { tool: 'fixture_effect' },
      {},
      {
        name: 'fixture_effect',
        description: 'A fixture side effect',
        initialLoad: true,
        schema: { type: 'object', properties: {} },
        execute: effect,
      }
    );
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(id, 'Wait for approval')) {
      events.push(event);
      if (event.type === 'approval_required')
        expect((await runtime.interruptQuery(id)).outcome).toBe('acked');
    }
    expect(effect).not.toHaveBeenCalled();
    expect(terminal(events)?.terminalReason).toBe('interrupted');
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
    expect(runtime.isTurnOpen(id)).toBe(false);
  });

  it('keeps missing wire usage unavailable instead of inventing zero tokens or cost', async () => {
    const { runtime, id } = await setup('openai-completions', { usage: false });
    const events = await collect(runtime.sendMessage(id, 'No usage report'));
    expect(text(events)).toBe('hello');
    expect(terminal(events)?.terminalReason).toBe('completed');
    expect(terminal(events)).not.toHaveProperty('turnInputTokens');
    expect(terminal(events)).not.toHaveProperty('turnOutputTokens');
    expect(terminal(events)).not.toHaveProperty('costUsd');
    expect(await runtime.readContextUsage(id)).toBeNull();
  });

  it('interrupts a genuinely hanging HTTP model request and drains owned cleanup', async () => {
    const { runtime, wire, id } = await setup('openai-completions', { hang: true });
    const draining = collect(runtime.sendMessage(id, 'Wait on wire'));
    await vi.waitFor(() => expect(wire.requests()).toBe(1));
    expect((await runtime.interruptQuery(id)).outcome).toBe('acked');
    const events = await draining;
    expect(terminal(events)?.terminalReason).toBe('interrupted');
    expect(runtime.isTurnOpen(id)).toBe(false);
    expect(events.filter((event) => event.type === 'done')).toHaveLength(1);
  });

  it('RT-SES-03: retains the frozen local payer and endpoint across restart after settings choose a different bill', async () => {
    const { runtime, wire, id, config, options } = await setup('openai-completions');
    expect(terminal(await collect(runtime.sendMessage(id, 'First turn')))?.terminalReason).toBe(
      'completed'
    );
    await runtime.shutdown();
    // The first runtime was explicitly closed; replace its registered cleanup.
    cleanups.pop();
    const changed = { ...config, source: 'api-key' as const, endpoint: 'http://127.0.0.1:1/v1' };
    const resolved = vi.fn((input: DoeInferenceConfig) =>
      resolveDoeInference(input, { providers: () => ({}) })
    );
    const restarted = new DoeRuntime({
      ...options,
      inference: () => changed,
      resolveModel: resolved,
    });
    cleanups.push(() => restarted.shutdown());
    expect(terminal(await collect(restarted.sendMessage(id, 'Second turn')))?.terminalReason).toBe(
      'completed'
    );
    expect(resolved).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'local', endpoint: wire.endpoint })
    );
    expect(restarted.sessions.get(id)?.inference).toMatchObject({ source: 'local' });
    expect(wire.requests()).toBe(2);
    expect(JSON.stringify(wire.bodies[1])).toContain('First turn');
    expect(JSON.stringify(wire.bodies[1])).toContain('hello');
  });

  it('refuses a missing own key before a model request and never falls back to local inference', async () => {
    const { runtime, wire, id, config, credentials } = await setup('openai-completions');
    config.source = 'api-key';
    const events = await collect(runtime.sendMessage(id, 'Require selected key'));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(JSON.stringify(events)).toContain('Save an API key');
    expect(wire.requests()).toBe(0);
    expect(credentials.resolve).not.toHaveBeenCalled();
    expect(runtime.sessions.get(id)?.inference).toMatchObject({ source: 'api-key' });
    expect(terminal(events)?.terminalReason).toBe('model_error');
  });

  it('refuses an unavailable bound own key without a request or a payer fallback', async () => {
    const { runtime, wire, id, config, credentials } = await setup('openai-completions');
    config.source = 'api-key';
    config.credentialRef = 'env:OFFLINE_FIXTURE';
    config.credentialEndpoint = config.endpoint;
    const events = await collect(runtime.sendMessage(id, 'Resolve selected key'));
    expect(credentials.resolve).toHaveBeenCalledWith('env:OFFLINE_FIXTURE');
    expect(wire.requests()).toBe(0);
    expect(JSON.stringify(events)).toContain('saved API key is unavailable');
    expect(runtime.sessions.get(id)?.inference).toMatchObject({ source: 'api-key' });
    expect(terminal(events)?.terminalReason).toBe('model_error');
  });

  it('redacts an explicitly supplied fixture key from provider errors and durable model messages', async () => {
    const secret = 'offline-fixture-secret-12345';
    const { runtime, wire, id, config } = await setup(
      'openai-completions',
      { status: 401, errorMessage: `invalid credential ${secret}` },
      {
        resolveModel: (input) =>
          resolveDoeInference(input, {
            providers: () => ({}),
            credentials: { resolve: async () => ({ ok: true, secret }) },
          }),
      }
    );
    config.source = 'api-key';
    config.credentialRef = 'env:OFFLINE_FIXTURE';
    config.credentialEndpoint = config.endpoint;
    const events = await collect(runtime.sendMessage(id, 'Fail privately'));
    expect(events.some((event) => event.type === 'error')).toBe(true);
    expect(JSON.stringify(events)).not.toContain(secret);
    expect(JSON.stringify(runtime.sessions.models.archive(id))).not.toContain(secret);
    expect(wire.requests()).toBe(1);
    expect(JSON.stringify(events)).toContain('redacted credential');
    expect(terminal(events)?.terminalReason).toBe('model_error');
  });

  it('correlates an actual builder child wire execution with the parent tool call', async () => {
    const { runtime, wire, id } = await setup('openai-completions', {
      tool: 'builder',
      toolArguments: { task: 'Describe a harmless fixture result' },
    });
    const events: StreamEvent[] = [];
    for await (const event of runtime.sendMessage(id, 'Delegate to the builder')) {
      events.push(event);
      if (event.type === 'approval_required')
        runtime.approveTool(id, (event.data as { toolCallId: string }).toolCallId, true);
    }
    const start = events.find((event) => event.type === 'background_task_started');
    expect(start?.data).toMatchObject({ toolUseId: 'call1', taskType: 'agent' });
    const childText = events.find((event) => event.type === 'subagent_text_delta');
    expect(childText?.data).toMatchObject({ parentToolUseId: 'call1', text: 'hello' });
    expect(events.filter((event) => event.type === 'background_task_done')).toHaveLength(1);
    expect(events.find((event) => event.type === 'background_task_done')?.data).toMatchObject({
      status: 'completed',
    });
    expect(text(events)).toBe('hello');
    expect(wire.requests()).toBe(3);
    expect(runtime.isTurnOpen(id)).toBe(false);
  });
});
