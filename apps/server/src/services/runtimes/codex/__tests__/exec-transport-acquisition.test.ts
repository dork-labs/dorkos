import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecCodexTransport } from '../transport/exec-transport.js';
import type { CodexTurnRequest } from '../transport/codex-transport.js';
import { createCodexEventContext } from '../event-mapper.js';

const sdk = vi.hoisted(() => {
  let entered!: () => void;
  let release!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const releasePromise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    entered,
    release,
    enteredPromise,
    releasePromise,
    loads: 0,
    hold: false,
    constructors: vi.fn(),
    start: vi.fn(),
    resume: vi.fn(),
    run: vi.fn(),
  };
});
vi.mock('@openai/codex-sdk', async () => {
  sdk.loads++;
  sdk.entered();
  if (sdk.hold) await sdk.releasePromise;
  return {
    Codex: class {
      constructor(options: unknown) {
        sdk.constructors(options);
      }
      startThread = sdk.start;
      resumeThread = sdk.resume;
    },
  };
});
vi.mock('../codex-options.js', () => ({
  buildCodexOptions: (binary: string) => ({ codexPathOverride: binary }),
  codexKeepAwakeConfig: () => ({}),
}));
vi.mock('../../shared/runtime-environment-config.js', () => ({ runtimeInheritedNames: () => [] }));

/** Resolved transport DATA only; no native permission or provider process is manufactured. */
function request(signal: AbortSignal, boundThreadId?: string): CodexTurnRequest {
  return {
    binary: '/original/codex',
    sessionId: 'session',
    boundThreadId,
    cwd: '/project',
    settings: {},
    writableDirectories: [],
    prompt: 'original prompt',
    launch: { home: 'person' },
    tools: {
      agentTokenEnv: {},
      managed: { servers: {}, env: {} },
      dorkosTools: null,
      connectorTools: null,
    },
    signal,
    events: createCodexEventContext('session'),
    onThreadBound: vi.fn(),
  };
}

afterEach(() => {
  sdk.release();
  vi.clearAllMocks();
});

describe('exec SDK acquisition', () => {
  it('imports no SDK until a turn and refuses an abort during the exact import await', async () => {
    expect(sdk.loads).toBe(0);
    const transport = new ExecCodexTransport();
    expect(sdk.loads).toBe(0);
    const controller = new AbortController();
    const stream = transport.runTurn(request(controller.signal));
    sdk.hold = true;
    const pending = stream.next();
    void pending.catch(() => {});
    try {
      await sdk.enteredPromise;
      expect(sdk.loads).toBe(1);
      expect(sdk.start).not.toHaveBeenCalled();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.run).not.toHaveBeenCalled();
      const cause = new Error('original turn retired while SDK loaded');
      controller.abort(cause);
      sdk.release();
      await expect(pending).rejects.toBe(cause);
      expect(sdk.start).not.toHaveBeenCalled();
      expect(sdk.resume).not.toHaveBeenCalled();
      expect(sdk.run).not.toHaveBeenCalled();
    } finally {
      sdk.release();
      await pending.catch(() => {});
      await stream.return(undefined);
    }
  });

  it.each([undefined, 'original-thread'] as const)(
    'retains original start/resume and SDK signal: %s',
    async (boundThreadId) => {
      sdk.start.mockReturnValue({ runStreamed: sdk.run });
      sdk.resume.mockReturnValue({ runStreamed: sdk.run });
      sdk.run.mockResolvedValue({ events: (async function* () {})() });
      const transport = new ExecCodexTransport();
      const controller = new AbortController();
      const turn = request(controller.signal, boundThreadId);
      const events = [];
      for await (const event of transport.runTurn(turn)) events.push(event);
      expect(sdk.loads).toBe(1);
      expect(sdk.constructors).toHaveBeenCalledWith({ codexPathOverride: turn.binary });
      if (boundThreadId === undefined) {
        expect(sdk.start).toHaveBeenCalledTimes(1);
        expect(sdk.resume).not.toHaveBeenCalled();
      } else {
        expect(sdk.resume).toHaveBeenCalledWith(boundThreadId, expect.any(Object));
        expect(sdk.start).not.toHaveBeenCalled();
      }
      expect(sdk.run).toHaveBeenCalledWith(turn.prompt, { signal: controller.signal });
      expect(events.at(-1)?.type).toBe('done');
    }
  );
});
