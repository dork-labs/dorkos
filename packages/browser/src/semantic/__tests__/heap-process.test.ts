import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { SEMANTIC_WORKER_FLAGS } from '../process-owner.js';
const originals: (() => Promise<void>)[] = [];
afterEach(async () => {
  const results = await Promise.allSettled(originals.splice(0).map((close) => close()));
  for (const result of results) if (result.status === 'rejected') throw result.reason;
});
// Actual Node process/V8 heap exhaustion only. No Chromium, total RSS or native allocator acceptance.
it('confines genuine V8 exhaustion to the exact original child while parent can still execute', async () => {
  const bank: { child?: ChildProcess; completion?: Promise<void> } = {};
  let closed = false,
    closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closed = true;
    closing ??= Promise.resolve().then(async () => {
      if (bank.child && bank.child.exitCode === null && bank.child.signalCode === null)
        bank.child.kill('SIGTERM');
      await bank.completion;
    });
    return closing;
  };
  originals.push(close);
  if (closed) throw new Error('FIXTURE_CLOSED');
  bank.child = spawn(
    process.execPath,
    [
      ...SEMANTIC_WORKER_FLAGS,
      '--eval',
      "const v8=require('node:v8');if(v8.getHeapStatistics().heap_size_limit>96*1024*1024)process.exit(2);process.stdout.write('original-heap-admitted\\n');const held=[];for(;;)held.push(Array.from({length:100000},(_,i)=>({i})));",
    ],
    {
      shell: false,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/bin:/bin' },
    }
  );
  const original = bank.child;
  let stdout = '',
    stderrBytes = 0;
  let code: number | null = null,
    signal: NodeJS.Signals | null = null;
  const streamClosed = [original.stdout!, original.stderr!].map(
    (stream) => new Promise<void>((resolve) => stream.once('close', resolve))
  );
  const terminal = new Promise<void>((resolve, reject) => {
    original.once('error', reject);
    original.once('exit', (value, reason) => {
      code = value;
      signal = reason;
    });
    original.once('close', () => resolve());
  });
  original.stdout!.on('data', (bytes: Buffer) => {
    if (stdout.length + bytes.length > 1024) {
      void close();
      return;
    }
    stdout += bytes.toString();
  });
  original.stderr!.on('data', (bytes: Buffer) => {
    stderrBytes += bytes.length;
    if (stderrBytes > 262144) void close();
  });
  bank.completion = Promise.all([terminal, ...streamClosed]).then(() => {});
  void bank.completion.catch(() => {});
  await bank.completion;
  expect(stdout).toBe('original-heap-admitted\n');
  expect(code === 0).toBe(false);
  expect(code !== null || signal !== null).toBe(true);
  expect(stderrBytes).toBeGreaterThan(0);
  expect(stderrBytes).toBeLessThanOrEqual(262144);
  expect(await Promise.resolve('original-parent-responsive')).toBe('original-parent-responsive');
});
