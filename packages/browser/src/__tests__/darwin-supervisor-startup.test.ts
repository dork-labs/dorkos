import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { startDarwinSupervisorClient } from '../runtime/darwin-supervisor-client.js';
const spawnMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn: spawnMock }));
afterEach(() => {
  vi.useRealTimers();
  spawnMock.mockReset();
});
it('bounds a blocked original seed send even when ready arrives, retaining refusal rather than inventing return', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const child = Object.assign(new EventEmitter(), {
    pid: 9,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    connected: true,
    disconnect: vi.fn(),
    send: vi.fn((_value: object, _callback: unknown) => true),
  });
  spawnMock.mockReturnValue(child);
  const startup = startDarwinSupervisorClient({
    workerPath: '/private/worker.mjs',
    browserId: 'browser',
    generation: 0,
    reservationNonce: randomUUID(),
    manager: { pid: process.pid, birth: 'semantic-manager' },
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
  });
  const rejected = expect(startup).rejects.toThrow('SUPERVISOR_STARTUP_EXPIRED');
  const seed = child.send.mock.calls[0]![0] as { nonce: string; reservationNonce: string };
  child.emit('message', {
    kind: 'ready',
    nonce: seed.nonce,
    browserId: 'browser',
    generation: 0,
    reservationNonce: seed.reservationNonce,
    root: { pid: 8, birth: 'semantic-root' },
    supervisor: { pid: 9, birth: 'semantic-supervisor' },
    endpointURL: 'ws://127.0.0.1:1234/devtools/browser/00000000-0000-0000-0000-000000000000',
    proxyURL: 'http://127.0.0.1:1234',
  });
  await vi.advanceTimersByTimeAsync(15000);
  await rejected;
  expect(child.send).toHaveBeenCalledTimes(2);
  expect(child.send.mock.calls[1]![0]).toMatchObject({
    kind: 'command',
    action: { kind: 'close' },
  });
  expect(child.disconnect).not.toHaveBeenCalled();
  // Return available semantic originals; deliberately unacknowledged sends still cannot be released.
  child.stdout.end();
  child.stderr.end();
  child.emit('exit', 0, null);
  child.emit('close', 0, null);
});
