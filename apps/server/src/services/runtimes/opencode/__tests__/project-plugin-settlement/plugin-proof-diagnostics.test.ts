/** @vitest-environment node */
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { expect, it } from 'vitest';
import { createPluginProofDiagnostics } from './plugin-proof-diagnostics.js';

function consumer() {
  const lines: string[] = [];
  const diagnostics = createPluginProofDiagnostics((line) => lines.push(line));
  return { diagnostics, records: () => lines.map((line) => JSON.parse(line)) };
}

it('the JSON consumer sees pending start, then settlement and the same result', async () => {
  const { diagnostics, records } = consumer();
  let finish!: (value: object) => void;
  const expected = {};
  const pending = diagnostics.call(
    'session.create',
    () =>
      new Promise<object>((resolve) => {
        finish = resolve;
      })
  );
  expect(records()).toEqual([
    expect.objectContaining({ kind: 'call', phase: 'start', label: 'session.create' }),
  ]);
  finish(expected);
  expect(await pending).toBe(expected);
  const parsed = records();
  expect(parsed.map((r) => r.phase)).toEqual(['start', 'settled']);
  expect(parsed[1]).toMatchObject({ kind: 'call', label: 'session.create' });
  expect(parsed[1].atMs).toBeGreaterThanOrEqual(parsed[0].atMs);
  expect(parsed[1].elapsedMs).toBeGreaterThanOrEqual(0);
});

it('records and propagates undefined rejection and synchronous throws without their contents', async () => {
  const { diagnostics, records } = consumer();
  await expect(
    diagnostics.call('mcp.status', () => Promise.reject(undefined))
  ).rejects.toBeUndefined();
  const error = new Error('credential content must not be printed');
  await expect(
    diagnostics.call('getClient', () => {
      throw error;
    })
  ).rejects.toBe(error);
  expect(records().map((r) => [r.label, r.phase])).toEqual([
    ['mcp.status', 'start'],
    ['mcp.status', 'rejected'],
    ['getClient', 'start'],
    ['getClient', 'rejected'],
  ]);
  expect(records()[1].reasonType).toBe('undefined');
  expect(JSON.stringify(records())).not.toContain(error.message);
});

it('retains PID identity and at most 4096 bytes of whole sanitized lines, then releases its reader', () => {
  const { diagnostics, records } = consumer();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 4321, stderr });
  diagnostics.native(child as unknown as ChildProcess, 'serve');
  expect(stderr.listenerCount('data')).toBe(1);
  child.emit('spawn');
  const oldLine = 'old:' + 'x'.repeat(3000) + '\n';
  const newLine = 'new:' + 'y'.repeat(3000) + '\n';
  stderr.write(oldLine.slice(0, 10));
  stderr.write(oldLine.slice(10) + newLine.slice(0, 15));
  stderr.write(newLine.slice(15));
  stderr.write('end');
  child.emit('close', 7, null);
  expect(records().map((r) => [r.phase, r.nativeId, r.role, r.pid])).toEqual([
    ['start', 1, 'serve', 4321],
    ['close', 1, 'serve', 4321],
  ]);
  expect(records()[1]).toMatchObject({ code: 7, signal: null, stderrTail: newLine + 'end' });
  expect(Buffer.byteLength(records()[1].stderrTail)).toBeLessThanOrEqual(4096);
  expect(stderr.listenerCount('data')).toBe(0);
  stderr.destroy();
});

it.each([false, true])('omits the entire oversized apiKey line (split chunks: %s)', (split) => {
  const { diagnostics, records } = consumer();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 4330, stderr });
  diagnostics.native(child as unknown as ChildProcess, 'serve');
  child.emit('spawn');
  const value = 'Z'.repeat(5000);
  if (split) {
    stderr.write('api');
    stderr.write('Key=' + value.slice(0, 2000));
    stderr.write(value.slice(2000));
  } else stderr.write('apiKey=' + value);
  child.emit('close', 0, null);
  expect(records()).toHaveLength(2);
  expect(records()[1].stderrTail).toBe('');
  expect(JSON.stringify(records())).not.toContain('Z');
  expect(stderr.listenerCount('data')).toBe(0);
  stderr.destroy();

  const later = new PassThrough();
  const next = Object.assign(new EventEmitter(), { pid: 4333, stderr: later });
  diagnostics.native(next as unknown as ChildProcess, 'serve');
  next.emit('spawn');
  later.write('apiKey=' + value + '\nbenign after oversized line\n');
  next.emit('close', 0, null);
  expect(records()).toHaveLength(4);
  expect(records()[3].stderrTail).toBe('benign after oversized line\n');
  expect(JSON.stringify(records())).not.toContain('Z');
  expect(later.listenerCount('data')).toBe(0);
  later.destroy();
});

it('joins split UTF-8, completes a valid final line, and omits an invalid final line', () => {
  const { diagnostics, records } = consumer();
  const complete = 'café🙂\n';
  const partial = 'finé🙂';
  for (const invalid of [false, true]) {
    const stderr = new PassThrough();
    const child = Object.assign(new EventEmitter(), { pid: invalid ? 4332 : 4331, stderr });
    diagnostics.native(child as unknown as ChildProcess, 'serve');
    child.emit('spawn');
    const bytes = Buffer.from(complete);
    stderr.write(bytes.subarray(0, 4));
    stderr.write(bytes.subarray(4, 7));
    stderr.write(bytes.subarray(7));
    if (invalid) stderr.write(Buffer.from([0xc3]));
    else stderr.write(partial);
    child.emit('close', 0, null);
    expect(stderr.listenerCount('data')).toBe(0);
    stderr.destroy();
  }
  const closed = records().filter((r) => r.phase === 'close');
  expect(closed.map((r) => [r.nativeId, r.pid, r.stderrTail])).toEqual([
    [1, 4331, complete + partial],
    [2, 4332, complete],
  ]);
});

it('omits credential-shaped stderr lines and a failed consumer cannot replace an outcome', async () => {
  const { diagnostics, records } = consumer();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), { pid: 4322, stderr });
  diagnostics.native(child as unknown as ChildProcess, 'run');
  child.emit('spawn');
  stderr.write('loading project\napiKey=owned-secret\nHOME=/private/fixture\n');
  child.emit('close', null, 'SIGTERM');
  expect(records()[1].stderrTail).toBe(
    'loading project\n[credential-like stderr line omitted]\n[credential-like stderr line omitted]\n'
  );
  const broken = createPluginProofDiagnostics(() => {
    throw new Error('consumer failed');
  });
  expect(await broken.call('config.get', async () => 42)).toBe(42);
  await expect(
    broken.call('provider.list', () => Promise.reject(undefined))
  ).rejects.toBeUndefined();
  stderr.destroy();
});
