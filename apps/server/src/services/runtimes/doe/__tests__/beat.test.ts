import { expect, it, vi } from 'vitest';
import { engine, makeRuntime, projectDir } from './runtime-fixture.js';
it('preflight skips the actual isolated Beat with zero model calls', async () => {
  const run = vi.fn(engine().run);
  const runtime = makeRuntime({ engineFactory: () => engine(run) });
  runtime.ensureSession('beat', { cwd: projectDir, permissionMode: 'default' });
  expect(
    await runtime.runBeat('beat', {
      id: 'skip',
      prompt: 'Check progress',
      decide: async () => ({ action: 'skip', reason: 'Nothing changed.' }),
    })
  ).toEqual({ kind: 'skipped', reason: 'Nothing changed.' });
  expect(run).not.toHaveBeenCalled();
  expect(runtime.sessions.models.archive('beat')).toEqual([]);
});
it.each(['quiet', 'raises'] as const)(
  'returns structured %s intent without adding prose to main conversation',
  async (kind) => {
    const runtime = makeRuntime({
      engineFactory: () =>
        engine(async (request) => {
          expect(request.context.scope).toBe(`beat:${kind}`);
          await request.tools
            .find((tool) => tool.name === 'end_beat')!
            .execute(
              kind === 'quiet'
                ? { kind }
                : { kind, raises: [{ message: 'The report is ready.', rung: 'report' }] },
              request.context
            );
          const message = { role: 'assistant', content: 'Internal check prose.' };
          request.onEvent({
            type: 'text',
            scope: request.context.scope,
            delta: 'Internal check prose.',
          });
          await request.onMessage(message);
          return { scope: request.context.scope, messages: [message], stopReason: 'stop' };
        }),
    });
    runtime.ensureSession('beat', { cwd: projectDir, permissionMode: 'default' });
    const result = await runtime.runBeat('beat', { id: kind, prompt: 'Check progress' });
    expect(result.kind).toBe(kind);
    expect(runtime.sessions.models.archive('beat')).toEqual([]);
    expect(runtime.sessions.models.outcomes('beat', `beat:${kind}`)[0]?.result).toEqual(result);
  }
);
