import { expect, it, vi } from 'vitest';
import { createDarwinEngineProcesses } from '../runtime/darwin-engine-processes.js';
const inspect = vi.hoisted(() => vi.fn());
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  createDarwinProcessObserver: () => ({ inspect }),
}));
it('keeps ordinary/recovery zombie liveness unknown while exposing its separate terminal fact', async () => {
  inspect.mockResolvedValue({
    bootSeconds: '1',
    bootMicroseconds: '0',
    processes: [
      { kind: 'present', identity: { pid: 7, seconds: '2', microseconds: '0' }, zombie: true },
    ],
  });
  const native = createDarwinEngineProcesses({
    path: '/private/semantic-only',
    sha256: 'a'.repeat(64),
  });
  const identity = { pid: 7, birth: 'darwin-bsd-start:2:0' };
  const signal = new AbortController().signal;
  expect(await native.processes.observe(identity, signal)).toEqual({ status: 'unknown' });
  expect(await native.observeTerminated(identity, signal)).toEqual({ status: 'dead' });
  inspect.mockResolvedValue({
    bootSeconds: '1',
    bootMicroseconds: '0',
    processes: [{ kind: 'unknown', pid: 7 }],
  });
  expect(await native.observeTerminated(identity, signal)).toEqual({ status: 'unknown' });
  const aborted = new AbortController();
  aborted.abort();
  expect(await native.observeTerminated(identity, aborted.signal)).toEqual({ status: 'unknown' });
});
