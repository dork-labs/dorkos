import type { ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpath, readFile } from 'node:fs/promises';
import * as fsPromises from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, open: vi.fn(actual.open) };
});
import { darwinBirth, parseDarwinProcessBatch } from '../runtime/darwin-process-observer.js';
const controls = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (original) => ({
  ...(await original<typeof import('node:child_process')>()),
  spawn: controls.spawn,
}));
const { spawn: actualSpawn } =
  await vi.importActual<typeof import('node:child_process')>('node:child_process');
controls.spawn.mockImplementation(actualSpawn);
const encode = (value: unknown) => Buffer.from(JSON.stringify(value));
it('preserves exact integer microseconds', () => {
  const identity = { pid: 10, seconds: '9007199254740993', microseconds: '123456' };
  const value = {
    version: 1,
    bootSeconds: '100',
    bootMicroseconds: '0',
    processes: [
      { kind: 'present', identity, parentPid: 1, zombie: true },
      { kind: 'unknown', pid: 20, error: 13 },
    ],
  };
  expect(parseDarwinProcessBatch(encode(value), [10, 20])).toEqual(value);
  expect(darwinBirth(identity).birth).toBe('darwin-bsd-start:9007199254740993:123456');
});
it('refuses missing or duplicate rows, invalid microseconds and oversized bytes', () => {
  const reply = {
    version: 1,
    bootSeconds: '1',
    bootMicroseconds: '0',
    processes: [{ kind: 'absent', pid: 10 }],
  };
  expect(() => parseDarwinProcessBatch(encode(reply), [10, 20])).toThrow();
  expect(() =>
    parseDarwinProcessBatch(
      encode({ ...reply, processes: [...reply.processes, ...reply.processes] }),
      [10, 20]
    )
  ).toThrow();
  expect(() =>
    parseDarwinProcessBatch(encode({ ...reply, bootMicroseconds: '1000000' }), [10])
  ).toThrow();
  expect(() => parseDarwinProcessBatch(new Uint8Array(256 * 1024 + 1), [10])).toThrow();
});

it.skipIf(process.platform !== 'darwin').each(['close', 'operation-and-close'] as const)(
  'keeps actual read custody across temporary observer instances (%s)',
  async (mode) => {
    vi.resetModules();
    const { createDarwinProcessObserver } = await import('../runtime/darwin-process-observer.js');
    // Genuine small executable; this fault refuses before any native process launch.
    const path = await realpath('/usr/bin/true');
    const artifact = {
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    };
    const mockedOpen = vi.mocked(fsPromises.open);
    const actualOpen = mockedOpen.getMockImplementation()!;
    const actualAdd = Set.prototype.add;
    const banks: Set<unknown>[] = [];
    let original: Awaited<ReturnType<typeof fsPromises.open>> | undefined;
    let closes = 0,
      opens = 0;
    const primary = new Error('actual operation failed before close');
    vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (original && value === original) banks.push(this);
      return actualAdd.call(this, value);
    });
    mockedOpen.mockImplementation(async (...args) => {
      opens++;
      const file = await actualOpen(...args);
      original = file;
      const actualClose = file.close.bind(file);
      vi.spyOn(file, 'close').mockImplementation(async () => {
        closes++;
        // The original really closes; rejection still cannot acknowledge return.
        await actualClose();
        throw new Error('ambiguous original close');
      });
      if (mode === 'operation-and-close') vi.spyOn(file, 'stat').mockRejectedValue(primary);
      return file;
    });
    try {
      const first = createDarwinProcessObserver(artifact).inspect([process.pid]);
      if (mode === 'operation-and-close') await expect(first).rejects.toBe(primary);
      else await expect(first).rejects.toThrow('ambiguous original close');
      expect(banks).toHaveLength(1);
      expect(banks[0].has(original)).toBe(true);
      await expect(createDarwinProcessObserver(artifact).inspect([process.pid])).rejects.toThrow(
        'PROCESS_OBSERVATION_UNAVAILABLE'
      );
      expect(opens).toBe(1);
      expect(closes).toBe(1);
      expect(banks[0].has(original)).toBe(true);
    } finally {
      mockedOpen.mockImplementation(actualOpen);
      vi.restoreAllMocks();
    }
  }
);

it.skipIf(process.platform !== 'darwin').each(['healthy', 'rejected-drain'] as const)(
  'retains actual helper originals across temporary observers (%s)',
  async (mode) => {
    vi.resetModules();
    const { createDarwinProcessObserver } = await import('../runtime/darwin-process-observer.js');
    const path = await realpath('/usr/bin/true');
    const artifact = {
      path,
      sha256: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    };
    const actualAdd = Set.prototype.add;
    const banks: Set<unknown>[] = [];
    let child: ChildProcess | undefined;
    let births = 0;
    vi.spyOn(Set.prototype, 'add').mockImplementation(function (
      this: Set<unknown>,
      value: unknown
    ) {
      if (child && value === child) banks.push(this);
      return actualAdd.call(this, value);
    });
    controls.spawn.mockImplementation((...args: Parameters<typeof actualSpawn>) => {
      births++;
      child = actualSpawn(...args);
      if (mode === 'rejected-drain')
        child.stdout![Symbol.asyncIterator] = async function* (): AsyncGenerator<never, undefined> {
          throw new Error('actual helper consumer drain failure');
        };
      return child;
    });
    try {
      // Genuine true has no native reply; no result is misrepresented as native facts.
      await expect(createDarwinProcessObserver(artifact).inspect([process.pid])).rejects.toThrow();
      expect(child?.exitCode).toBe(0);
      expect(child?.signalCode).toBeNull();
      expect(banks).toHaveLength(1);
      expect(banks[0].has(child)).toBe(mode === 'rejected-drain');
      if (mode === 'rejected-drain') {
        await expect(createDarwinProcessObserver(artifact).inspect([process.pid])).rejects.toThrow(
          'PROCESS_OBSERVATION_UNAVAILABLE'
        );
        expect(births).toBe(1);
        expect(banks[0].has(child)).toBe(true);
      }
    } finally {
      controls.spawn.mockImplementation(actualSpawn);
      vi.restoreAllMocks();
    }
  }
);

it.each([
  'birth-changed',
  'parent-changed',
  'alive-to-zombie',
  'zombie-to-alive',
  'membership-disappeared',
  'membership-appeared',
  'membership-absent-with-present-reads',
] as const)(
  'preserves original native unknown evidence %s without creating presence or absence',
  (uncertainty) => {
    const value = {
      version: 1,
      bootSeconds: '1',
      bootMicroseconds: '0',
      processes: [{ kind: 'unknown', pid: 10, error: 35, uncertainty }],
    };
    expect(parseDarwinProcessBatch(encode(value), [10])).toEqual(value);
    expect(() =>
      parseDarwinProcessBatch(
        encode({
          ...value,
          processes: [{ ...value.processes[0], uncertainty: 'other-untrusted' }],
        }),
        [10]
      )
    ).toThrow();
  }
);
