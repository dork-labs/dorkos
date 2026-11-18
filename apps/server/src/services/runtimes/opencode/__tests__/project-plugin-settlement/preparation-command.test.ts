/** @vitest-environment node
 * Synthetic Node child events only: no npm, OS-process custody, network or package proof.
 */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { afterEach, expect, it, vi } from 'vitest';
import { runPreparationCommand } from './preparation-command.js';

afterEach(() => vi.useRealTimers());
function subject(pid: number | undefined = 123) {
  const child = Object.assign(new EventEmitter(), {
    pid: pid as number | undefined,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const records: string[] = [];
  let settled = false;
  const pending = runPreparationCommand(
    'ci',
    ['ci'],
    '/synthetic',
    {},
    performance.now() + 1000,
    () => child as unknown as ChildProcess,
    (line) => records.push(line)
  );
  const outcome = pending.then(
    () => {
      settled = true;
      return 'ok';
    },
    (error: Error) => {
      settled = true;
      return error.message;
    }
  );
  return { child, records, outcome, settled: () => settled };
}

it('drains bounded synthetic success and settles only on close, without retaining raw output', async () => {
  const s = subject();
  s.child.stdout.write('private raw output');
  s.child.stderr.write('more output');
  await Promise.resolve();
  expect(s.settled()).toBe(false);
  s.child.emit('close', 0, null);
  expect(await s.outcome).toBe('ok');
  expect(s.child.kill).not.toHaveBeenCalled();
  expect(JSON.parse(s.records[0])).toMatchObject({
    stage: 'ci',
    reason: null,
    code: 0,
    signal: null,
    pid: 123,
  });
  expect(s.records.join('')).not.toContain('private');
  expect(s.child.stdout.listenerCount('data')).toBe(0);
});

it('latches synthetic error, kills once and waits for actual close despite subsequent failures', async () => {
  const s = subject();
  s.child.emit('error', new Error('raw secret'));
  s.child.stderr.write(Buffer.alloc(2 * 1024 * 1024 + 1));
  await Promise.resolve();
  expect(s.settled()).toBe(false);
  expect(s.records).toEqual([]);
  expect(s.child.kill).toHaveBeenCalledTimes(1);
  s.child.emit('close', null, 'SIGKILL');
  expect(await s.outcome).toContain('process-error');
  expect(JSON.parse(s.records[0])).toMatchObject({ reason: 'process-error', signal: 'SIGKILL' });
  expect(s.records.join('')).not.toContain('raw secret');
});

it('deadline kills a synthetic child once but cannot report settlement before close', async () => {
  vi.useFakeTimers();
  const s = subject();
  await vi.advanceTimersByTimeAsync(1001);
  expect(s.settled()).toBe(false);
  expect(s.child.kill).toHaveBeenCalledTimes(1);
  s.child.emit('close', null, 'SIGKILL');
  expect(await s.outcome).toContain('deadline');
});

it('combined stream overflow kills once and remains pending until synthetic close', async () => {
  const s = subject();
  s.child.stdout.write(Buffer.alloc(1024 * 1024));
  s.child.stderr.write(Buffer.alloc(1024 * 1024 + 1));
  await Promise.resolve();
  expect(s.settled()).toBe(false);
  expect(s.child.kill).toHaveBeenCalledTimes(1);
  s.child.emit('close', null, 'SIGKILL');
  expect(await s.outcome).toContain('output-limit');
});

it('distinguishes a synthetic spawn error without PID and still awaits close', async () => {
  const s = subject();
  s.child.pid = undefined;
  s.child.emit('error', new Error('ENOENT private'));
  await Promise.resolve();
  expect(s.settled()).toBe(false);
  expect(s.child.kill).not.toHaveBeenCalled();
  s.child.emit('close', -2, null);
  expect(await s.outcome).toContain('spawn-error-no-pid');
  expect(JSON.parse(s.records[0]).pid).toBeNull();
});

it('nonzero synthetic terminal status fails with safe exit diagnostics', async () => {
  const s = subject();
  s.child.emit('close', 7, null);
  expect(await s.outcome).toContain('exit');
  expect(JSON.parse(s.records[0])).toMatchObject({ reason: 'exit', code: 7, signal: null });
});
