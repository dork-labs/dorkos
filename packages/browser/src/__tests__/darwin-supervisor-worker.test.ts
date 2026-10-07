import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { runDarwinSupervisorWorker } from '../runtime/darwin-supervisor-worker.js';
const mocks = vi.hoisted(() => ({
  close: vi.fn(async () => true),
  launch: vi.fn(),
}));
vi.mock('../runtime/darwin-supervisor-browser.js', () => ({
  launchDarwinSupervisorBrowser: mocks.launch,
}));
it('enters original browser cleanup while the original ready send acknowledgement is withheld', async () => {
  const beforeMessages = new Set(process.listeners('message'));
  const beforeDisconnect = new Set(process.listeners('disconnect'));
  const previousExit = process.exitCode;
  const connected = Object.getOwnPropertyDescriptor(process, 'connected');
  const send = Object.getOwnPropertyDescriptor(process, 'send');
  const disconnect = vi.spyOn(process, 'disconnect').mockImplementation(() => {});
  const diagnostics: string[] = [];
  const sink = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    diagnostics.push(String(chunk));
    return true;
  });
  const callbacks: Array<(error: Error | null) => void> = [];
  Object.defineProperty(process, 'connected', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process, 'send', {
    configurable: true,
    value: vi.fn((_message, callback) => {
      callbacks.push(callback);
      return true;
    }),
  });
  mocks.launch.mockResolvedValue({
    close: mocks.close,
    root: { pid: 8, birth: 'semantic-root' },
    supervisor: { pid: process.pid, birth: 'semantic-supervisor' },
    proxyURL: 'http://127.0.0.1:1234',
    endpointURL: 'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',
  });
  const seed = {
    kind: 'launch',
    nonce: randomUUID(),
    browserId: 'browser',
    generation: 0,
    reservationNonce: randomUUID(),
    manager: { pid: process.ppid, birth: 'semantic-manager' },
    profileDir: '/private/profile',
    origin: 'http://127.0.0.1:1234',
    artifact: { path: '/private/observer', sha256: 'a'.repeat(64) },
    runtime: {
      library: {
        package: 'playwright-core',
        version: '1.63.0',
        rootDir: '/private/library',
        assets: { manifest: 'browsers.json', cli: 'cli.js' },
      },
      executable: {
        path: '/private/chromium',
        sha256: 'b'.repeat(64),
        revision: '1243',
        version: '153.0.8010.12',
        platform: 'darwin',
        arch: 'arm64',
      },
      identity: { mode: 'native', policyRevision: 1 },
    },
  };
  try {
    await runDarwinSupervisorWorker();
    process.emit('message', seed, undefined);
    await vi.waitFor(() => expect(callbacks).toHaveLength(1));
    process.emit('disconnect');
    await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledTimes(1));
    expect(callbacks).toHaveLength(1);
    // Pending genuine reply acknowledgement refuses a positive return, without delaying peer cleanup.
    await vi.waitFor(() => expect(process.exitCode).toBe(1));
    expect(diagnostics.join('')).toContain('SUPERVISOR_UNCERTAIN: WORKER_SENDS_PENDING');
    callbacks[0]!(null);
  } finally {
    for (const callback of callbacks) callback(null);
    for (const listener of process.listeners('message'))
      if (!beforeMessages.has(listener)) process.removeListener('message', listener);
    for (const listener of process.listeners('disconnect'))
      if (!beforeDisconnect.has(listener)) process.removeListener('disconnect', listener);
    if (connected) Object.defineProperty(process, 'connected', connected);
    else Reflect.deleteProperty(process, 'connected');
    if (send) Object.defineProperty(process, 'send', send);
    else Reflect.deleteProperty(process, 'send');
    process.exitCode = previousExit;
    disconnect.mockRestore();
    sink.mockRestore();
  }
});

it.each(['matching', 'wrong-root', 'wrong-generation', 'disconnect-held-send'] as const)(
  'joins exact original child acknowledgement before SDK; %s',
  async (mode) => {
    const beforeMessages = new Set(process.listeners('message')),
      beforeDisconnect = new Set(process.listeners('disconnect'));
    const previousExit = process.exitCode,
      connected = Object.getOwnPropertyDescriptor(process, 'connected'),
      send = Object.getOwnPropertyDescriptor(process, 'send');
    const disconnect = vi.spyOn(process, 'disconnect').mockImplementation(() => {});
    const emitted: Array<Record<string, unknown>> = [];
    const held: Array<(error: Error | null) => void> = [];
    const sdk = vi.fn();
    mocks.close.mockClear();
    Object.defineProperty(process, 'connected', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process, 'send', {
      configurable: true,
      value: vi.fn((message, callback) => {
        emitted.push(message);
        if (mode === 'disconnect-held-send' && message.kind === 'originalChild')
          held.push(callback);
        else callback(null);
        return true;
      }),
    });
    const original = {
      root: { pid: 123, birth: 'original-root' },
      supervisor: { pid: process.pid, birth: 'original-supervisor' },
      manager: { pid: process.ppid, birth: 'original-manager' },
      identities: [{ pid: 123, birth: 'original-root' }],
      complete: true,
    };
    mocks.launch.mockImplementation(async (_seed, _failed, _returned, observe) => {
      try {
        await observe(original);
      } catch (error) {
        await mocks.close();
        throw error;
      }
      sdk();
      return {
        close: mocks.close,
        root: original.root,
        supervisor: original.supervisor,
        proxyURL: 'http://127.0.0.1:1234',
        endpointURL: 'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',
      };
    });
    const seed = {
      kind: 'launch',
      observeOriginalChild: true,
      nonce: randomUUID(),
      reservationNonce: randomUUID(),
      browserId: 'original-browser',
      generation: 1,
      manager: original.manager,
      profileDir: '/private/original-worker',
      origin: 'about:blank',
      ownedProxy: {
        url: 'http://127.0.0.1:1234',
        credentials: { username: 'dorkos', password: 'private' },
      },
      artifact: { path: '/private/not-executed', sha256: 'a'.repeat(64) },
      runtime: {
        library: {
          package: 'playwright-core',
          version: '1.63.0',
          rootDir: '/private/library',
          assets: { manifest: 'browsers.json', cli: 'cli.js' },
        },
        executable: {
          path: '/private/chromium',
          sha256: 'b'.repeat(64),
          revision: '1243',
          version: '153.0.8010.12',
          platform: 'darwin',
          arch: 'arm64',
        },
        identity: { mode: 'native', policyRevision: 1 },
      },
    };
    try {
      await runDarwinSupervisorWorker();
      process.emit('message', seed, undefined);
      await vi.waitFor(() =>
        expect(emitted.some((row) => row.kind === 'originalChild')).toBe(true)
      );
      expect(sdk).not.toHaveBeenCalled();
      expect(emitted.some((row) => row.kind === 'ready')).toBe(false);
      if (mode === 'disconnect-held-send') {
        process.emit('disconnect');
        await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
        expect(sdk).not.toHaveBeenCalled();
        expect(held).toHaveLength(1);
        held[0]!(null);
      } else {
        process.emit(
          'message',
          {
            kind: 'originalChildObserved',
            nonce: seed.nonce,
            reservationNonce: seed.reservationNonce,
            browserId: seed.browserId,
            generation: mode === 'wrong-generation' ? 2 : 1,
            original:
              mode === 'wrong-root'
                ? {
                    ...original,
                    root: { ...original.root, birth: 'reused-root' },
                  }
                : original,
          },
          undefined
        );
        if (mode === 'matching') {
          await vi.waitFor(() => expect(sdk).toHaveBeenCalledOnce());
          await vi.waitFor(() => expect(emitted.some((row) => row.kind === 'ready')).toBe(true));
          process.emit(
            'message',
            {
              kind: 'command',
              nonce: seed.nonce,
              sequence: 1,
              action: { kind: 'close' },
            },
            undefined
          );
        } else {
          await vi.waitFor(() => expect(mocks.close).toHaveBeenCalledOnce());
          expect(sdk).not.toHaveBeenCalled();
        }
      }
      await vi.waitFor(() => expect(disconnect).toHaveBeenCalled());
    } finally {
      for (const callback of held) callback(null);
      for (const listener of process.listeners('message'))
        if (!beforeMessages.has(listener)) process.removeListener('message', listener);
      for (const listener of process.listeners('disconnect'))
        if (!beforeDisconnect.has(listener)) process.removeListener('disconnect', listener);
      if (connected) Object.defineProperty(process, 'connected', connected);
      else Reflect.deleteProperty(process, 'connected');
      if (send) Object.defineProperty(process, 'send', send);
      else Reflect.deleteProperty(process, 'send');
      process.exitCode = previousExit;
      disconnect.mockRestore();
      mocks.launch.mockReset();
    }
  }
);
