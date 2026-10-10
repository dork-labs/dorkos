/** @vitest-environment node */
import { describe, expect, it } from 'vitest';
import { doeBuilderTool } from '../builder.js';
const resources = {
  load: async () => '',
  beforeFile: async () => '',
  skills: async () => [],
  loadSkill: async () => '',
};
describe('Doe builder boundary', () => {
  it('requires a scoped engine execution and propagates cancellation without running scripts', async () => {
    const tool = doeBuilderTool({
      cwd: process.cwd(),
      resources,
      pathPolicy: { readRoots: [process.cwd()], writeRoots: [process.cwd()] },
    });
    const abort = new AbortController();
    abort.abort();
    const result = await tool.execute(
      { task: 'run a skill script' },
      {
        sessionId: 'session',
        scope: 'main',
        workingDirectory: process.cwd(),
        signal: abort.signal,
        emit: () => {},
      }
    );
    expect(result.isError).toBe(true);
  });
  it('runs scripts only in the child coding scope with explicit execution policy', async () => {
    const cwd = process.cwd();
    const tool = doeBuilderTool({
      cwd,
      resources,
      pathPolicy: { readRoots: [cwd], writeRoots: [cwd] },
      executionPolicy: {
        kind: 'isolated',
        execute: async () => ({
          stdout: 'script result',
          stderr: '',
          exitCode: 0,
          truncated: false,
        }),
      },
    });
    const result = await tool.execute(
      { task: 'Run the skill script' },
      {
        sessionId: 'session',
        scope: 'main',
        workingDirectory: cwd,
        signal: new AbortController().signal,
        emit: () => {},
        execute: async (child) => {
          expect(child.scope).toMatch(/^child:/);
          expect(child.prompt).toContain('coding builder');
          const shell = child.tools.find((item) => item.name === 'shell')!;
          expect(
            (
              await shell.execute(
                { command: 'script' },
                {
                  sessionId: 'session',
                  scope: child.scope,
                  workingDirectory: cwd,
                  signal: child.signal!,
                  emit: () => {},
                }
              )
            ).content
          ).toEqual(expect.arrayContaining([expect.objectContaining({ text: 'script result' })]));
          return {
            messages: [{ role: 'assistant', content: 'Script completed' }],
            usage: [],
            stopReason: 'stop',
          };
        },
      }
    );
    expect(result.isError).not.toBe(true);
  });
});

it('refuses shell execution when the host omitted execution authority', async () => {
  const cwd = process.cwd();
  const tool = doeBuilderTool({
    cwd,
    resources,
    pathPolicy: { readRoots: [cwd], writeRoots: [cwd] },
  });
  let shellRefused = false;
  await tool.execute(
    { task: 'Run skill script' },
    {
      sessionId: 'session',
      scope: 'main',
      workingDirectory: cwd,
      signal: new AbortController().signal,
      emit: () => {},
      execute: async (child) => {
        const result = await child.tools
          .find((item) => item.name === 'shell')!
          .execute(
            { command: 'printf unsafe' },
            {
              sessionId: 'session',
              scope: child.scope,
              workingDirectory: cwd,
              signal: child.signal!,
              emit: () => {},
            }
          );
        shellRefused = result.isError === true;
        expect(result.content).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ text: 'Shell requires an explicit host execution policy' }),
          ])
        );
        return {
          messages: [{ role: 'assistant', content: 'Script refused' }],
          usage: [],
          stopReason: 'stop',
        };
      },
    }
  );
  expect(shellRefused).toBe(true);
});

it('correlates the real engine builder child to its actual parent tool call', async () => {
  const cwd = process.cwd(),
    events: unknown[] = [];
  const tool = doeBuilderTool({
    cwd,
    resources,
    pathPolicy: { readRoots: [cwd], writeRoots: [cwd] },
    onChildStart: (scope, parent) => events.push(['start', scope, parent]),
    onChildEnd: (scope, outcome) => events.push(['end', scope, outcome.kind]),
  });
  const result = await tool.execute(
    { task: 'Implement a business tool' },
    {
      sessionId: 'session',
      callId: 'actual-parent-tool-call',
      scope: 'main',
      workingDirectory: cwd,
      signal: new AbortController().signal,
      emit: () => {},
      execute: async (child) => {
        expect(events).toEqual([['start', child.scope, 'actual-parent-tool-call']]);
        expect(child.scope).toMatch(/^child:/);
        return {
          messages: [{ role: 'assistant', content: 'Built the tool' }],
          usage: [],
          stopReason: 'stop',
        };
      },
    }
  );
  expect(result.isError).not.toBe(true);
  expect(events).toHaveLength(2);
  expect(events[1]).toEqual(['end', (events[0] as string[])[1], 'result']);
});

it('ends the correlated child on execution failure without reporting success', async () => {
  const cwd = process.cwd(),
    events: unknown[] = [];
  const tool = doeBuilderTool({
    cwd,
    resources,
    pathPolicy: { readRoots: [cwd], writeRoots: [cwd] },
    onChildStart: (scope, parent) => events.push(['start', scope, parent]),
    onChildEnd: (scope, outcome) => events.push(['end', scope, outcome.kind]),
  });
  const result = await tool.execute(
    { task: 'Build' },
    {
      sessionId: 'session',
      callId: 'parent',
      scope: 'main',
      workingDirectory: cwd,
      signal: new AbortController().signal,
      emit: () => {},
      execute: async () => {
        throw new Error('Child execution failed');
      },
    }
  );
  expect(result.isError).toBe(true);
  expect(events).toHaveLength(2);
  expect(events[1]).toEqual(['end', (events[0] as string[])[1], 'error']);
});

it('ends the correlated child when cancellation interrupts a hanging executor', async () => {
  const cwd = process.cwd(),
    events: string[] = [],
    abort = new AbortController();
  const tool = doeBuilderTool({
    cwd,
    resources,
    pathPolicy: { readRoots: [cwd], writeRoots: [cwd] },
    onChildStart: () => events.push('start'),
    onChildEnd: (_scope, outcome) => events.push(outcome.kind),
  });
  const result = tool.execute(
    { task: 'Build' },
    {
      sessionId: 'session',
      callId: 'parent',
      scope: 'main',
      workingDirectory: cwd,
      signal: abort.signal,
      emit: () => {},
      execute: async () => {
        abort.abort();
        return new Promise<never>(() => {});
      },
    }
  );
  expect((await result).isError).toBe(true);
  expect(events).toEqual(['start', 'error']);
});
