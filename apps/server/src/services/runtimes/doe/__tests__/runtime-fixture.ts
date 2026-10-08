import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { onTestFinished, afterAll } from 'vitest';
import type { Engine, EngineRequest, ModelDescriptor } from '@dorkos/doe';
import { DoeRuntime, type DoeRuntimeOptions } from '../doe-runtime.js';

export const controls = new WeakMap<DoeRuntime, { run?: Engine['run'] }>();
export const requests: EngineRequest[] = [];
export const projectDir = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'doe-project-')));
afterAll(() => rmSync(projectDir, { recursive: true, force: true }));
export const model: ModelDescriptor = {
  protocol: 'openai-completions',
  endpoint: 'http://127.0.0.1:1/v1',
  id: 'local',
  contextWindow: 200000,
  maxOutputTokens: 1000,
  payer: 'local',
  historyFamily: 'chat',
  requiresCredentials: false,
  credentials: async () => undefined,
};
export const inference = {
  source: 'local' as const,
  provider: 'local',
  protocol: 'openai-chat-completions' as const,
  endpoint: model.endpoint,
  model: model.id,
  contextWindow: model.contextWindow,
  maxOutputTokens: model.maxOutputTokens,
};
export function engine(run?: Engine['run']): Engine {
  return {
    run:
      run ??
      (async (request) => {
        requests.push(request);
        await request.prepareRequest?.(request.messages, request.signal);
        const message = { role: 'assistant', content: 'Finished.' };
        request.onEvent({ type: 'text', delta: 'Finished.', scope: request.context.scope });
        await request.onMessage(message);
        await request.onUsage({
          requestId: randomUUID(),
          inputTokens: 100,
          outputTokens: 5,
          costUsd: 0.01,
        });
        return { messages: [message], scope: request.context.scope, stopReason: 'stop' };
      }),
    steer: () => 'queued',
    followUp: () => 'queued',
    abort: () => {},
  };
}
export function makeRuntime(options: DoeRuntimeOptions = {}): DoeRuntime {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'doe-runtime-'));
  const control: { run?: Engine['run'] } = {};
  const runtime = new DoeRuntime({
    directory,
    defaultCwd: projectDir,
    inference: () => inference,
    resolveModel: async () => model,
    engineFactory: () => engine(control.run),
    ...options,
  });
  controls.set(runtime, control);
  onTestFinished(async () => {
    await runtime.shutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return runtime;
}
export async function drain(runtime: DoeRuntime, id: string = randomUUID(), content = 'Hello') {
  runtime.ensureSession(id, { cwd: projectDir, permissionMode: 'default' });
  return collect(runtime.sendMessage(id, content, { cwd: projectDir, permissionMode: 'default' }));
}

export async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];
  for await (const value of source) values.push(value);
  return values;
}
