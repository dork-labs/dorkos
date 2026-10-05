import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { startDarwinEngineJournal } from '../runtime/darwin-engine-journal.js';

const controls = vi.hoisted(() => ({ inspect: vi.fn(), start: vi.fn() }));
vi.mock('../runtime/darwin-process-observer.js', async (original) => ({
  ...(await original<typeof import('../runtime/darwin-process-observer.js')>()),
  createDarwinProcessObserver: () => ({ inspect: controls.inspect }),
}));
vi.mock('../runtime/darwin-journal-worker.js', () => ({
  startDarwinJournalWorker: controls.start,
  darwinMonotonicNow: () => 100,
}));
const roots: string[] = [];
afterEach(async () => {
  vi.clearAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const parentDirectory = await realpath(await mkdtemp(join(tmpdir(), 'engine-journal-')));
  roots.push(parentDirectory);
  controls.inspect.mockResolvedValue({
    bootSeconds: '10',
    bootMicroseconds: '0',
    processes: [
      {
        kind: 'present',
        identity: { pid: process.pid, seconds: '20', microseconds: '0' },
        zombie: false,
      },
    ],
  });
  return {
    parentDirectory,
    binding: {
      journalId: 'journal',
      browserId: 'browser',
      browserGeneration: 0,
      reservationNonce: 'nonce',
      profile: { kind: 'ephemeral' as const },
      runtimeIdentityDigest: 'a'.repeat(64),
      manager: { pid: process.pid, birth: 'darwin-bsd-start:20:0' },
    },
    workerPath: '/private/worker.js',
    artifact: { path: '/private/observer', sha256: 'b'.repeat(64) },
    duration: 1000,
    maxGap: 100,
  };
}
it('awaits enrollment and retains the same completion through stop without early release', async () => {
  let finish!: (value: 'recorded-gone') => void;
  const completion = new Promise<'recorded-gone'>((resolve) => {
    finish = resolve;
  });
  const enrollRoot = vi.fn(async () => {});
  controls.start.mockResolvedValue({ completion, enrollRoot, endBrowser: vi.fn(async () => {}) });
  const adapter = await startDarwinEngineJournal(await fixture());
  const seed = controls.start.mock.calls[0][0];
  expect(seed.initial.root.kind).toBe('pending');
  expect(seed.initial.binding.bootScope.sourceIdentityDigest).toBe('b'.repeat(64));
  const root = { pid: 123, birth: 'darwin-bsd-start:21:0' };
  await adapter.attributeRoot(root);
  expect(enrollRoot).toHaveBeenCalledExactlyOnceWith(root);
  await expect(adapter.attributeRoot(root)).rejects.toThrow('JOURNAL_ROOT_REFUSED');
  const first = adapter.stop();
  expect(adapter.stop()).toBe(first);
  expect(adapter.custody().pending).toBe(true);
  finish('recorded-gone');
  expect(await first).toBe('recorded-gone');
  expect(adapter.custody()).toEqual({ pending: false, uncertain: false });
});
it('preserves failed root attribution despite later reported completion', async () => {
  let finish!: (value: 'recorded-gone') => void;
  const completion = new Promise<'recorded-gone'>((resolve) => {
    finish = resolve;
  });
  controls.start.mockResolvedValue({
    completion,
    enrollRoot: vi.fn(async () => {
      throw new Error('IPC failed');
    }),
    endBrowser: vi.fn(async () => {}),
  });
  const adapter = await startDarwinEngineJournal(await fixture());
  await expect(adapter.attributeRoot({ pid: 123, birth: 'root' })).rejects.toThrow('IPC failed');
  finish('recorded-gone');
  expect(await adapter.stop()).toBe('uncertain');
  expect(adapter.custody().uncertain).toBe(true);
});
