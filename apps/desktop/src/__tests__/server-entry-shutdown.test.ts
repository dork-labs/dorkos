import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cleanup = vi.hoisted(() => ({
  computer: vi.fn<() => Promise<void>>(),
  order: [] as string[],
}));
vi.mock('../orphan-watchdog', () => ({ exitWhenOrphaned: vi.fn() }));
vi.mock('@dorkos/server', () => ({}));
vi.mock('../../../server/src/startup/computers.js', () => ({
  shutdownComputers: () => cleanup.computer(),
}));
vi.mock('../../../server/src/lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../../../server/src/services/runtimes/opencode/index.js', () => ({
  openCodeServerManager: {
    shutdown: async () => {
      cleanup.order.push('opencode');
    },
  },
}));
vi.mock('../../../server/src/services/runtimes/codex/app-server/process-pool.js', () => ({
  codexAppServerPool: {
    shutdown: async () => {
      cleanup.order.push('codex');
    },
  },
}));
vi.mock(
  '../../../server/src/services/runtimes/claude-code/sessions/session-pump-registry.js',
  () => ({
    shutdownSessionPumps: async () => {
      cleanup.order.push('pumps');
    },
  })
);

type ShutdownFactory = (
  services: () => Promise<void>,
  deps: { exit: (code: number) => void }
) => () => Promise<void>;
const originalParentPort = Object.getOwnPropertyDescriptor(process, 'parentPort');
let receive: (event: { data: unknown }) => void;
let signals: EventEmitter;
let completed: Promise<void> | undefined;
let finishComputer: () => void;
const exit = vi.fn<(code: number) => never>();

beforeEach(async () => {
  vi.resetModules();
  cleanup.order.length = 0;
  cleanup.computer.mockReset();
  exit.mockReset().mockImplementation(() => undefined as never);
  completed = undefined;
  signals = new EventEmitter();
  const port = {
    postMessage: vi.fn(),
    on: vi.fn((_event: string, handler: typeof receive) => {
      receive = handler;
    }),
  };
  Object.defineProperty(process, 'parentPort', { configurable: true, value: port });
  const originalEmit = process.emit;
  vi.spyOn(process, 'emit').mockImplementation(((event: string | symbol, ...args: unknown[]) =>
    event === 'SIGTERM'
      ? signals.emit(event, ...args)
      : Reflect.apply(originalEmit, process, [event, ...args])) as typeof process.emit);
  vi.spyOn(process, 'exit').mockImplementation((code) => exit(Number(code ?? 0)));
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  // Import the actual server shutdown chain without making desktop's tsc trace
  // the server's separate NodeNext program through a static cross-app import.
  const { createSignalShutdown } = await vi.importActual<{ createSignalShutdown: ShutdownFactory }>(
    '../../../server/src/lib/shutdown-signal.ts'
  );
  const { shutdownRuntimes } = await vi.importActual<{
    shutdownRuntimes: (relay: null) => Promise<void>;
  }>('../../../server/src/startup/shutdown-runtimes.ts');
  cleanup.computer.mockImplementation(() => {
    cleanup.order.push('computer-start');
    return new Promise<void>((resolve) => {
      finishComputer = () => {
        cleanup.order.push('computer-stopped');
        resolve();
      };
    });
  });
  const shutdown = createSignalShutdown(() => shutdownRuntimes(null), { exit });
  signals.on('SIGTERM', () => {
    completed = shutdown();
  });
  await import('../server-entry');
  await vi.waitFor(() => expect(port.postMessage).toHaveBeenCalledWith({ type: 'ready' }));
});

afterEach(() => {
  if (originalParentPort) Object.defineProperty(process, 'parentPort', originalParentPort);
  else Reflect.deleteProperty(process, 'parentPort');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('desktop shutdown IPC joins the server runtime cleanup', () => {
  it('waits for the computer and host runtimes before a clean exit', async () => {
    receive({ data: { type: 'shutdown' } });
    expect(cleanup.order).toEqual(['computer-start']);
    expect(exit).not.toHaveBeenCalled();
    finishComputer();
    await completed;
    expect(cleanup.order).toEqual([
      'computer-start',
      'computer-stopped',
      'opencode',
      'codex',
      'pumps',
    ]);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('does not turn duplicate IPC into the force-exit signal', async () => {
    receive({ data: { type: 'shutdown' } });
    receive({ data: { type: 'shutdown' } });
    expect(cleanup.computer).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    finishComputer();
    await completed;
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('retains the supervisor force-exit path when computer cleanup cannot finish', async () => {
    receive({ data: { type: 'shutdown' } });
    const firstShutdown = completed;
    expect(exit).not.toHaveBeenCalled();
    signals.emit('SIGTERM');
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(cleanup.order).toEqual(['computer-start']);
    // Settle the first call so the test leaves no pending cleanup behind.
    finishComputer();
    await firstShutdown;
  });

  it('ignores unrelated parent messages', () => {
    for (const data of [null, 'shutdown', {}, { type: 'ready' }]) receive({ data });
    expect(cleanup.computer).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });
});
