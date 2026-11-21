import { beforeEach, expect, it, vi } from 'vitest';
import { createTerminalCleanupReceipt } from '../run-custody/posix/terminal-cleanup-receipt.mjs';

const io = vi.hoisted(() => ({ stat: vi.fn(), write: vi.fn(), close: vi.fn() }));
vi.mock('node:fs', () => ({ fstatSync: io.stat, writeSync: io.write, closeSync: io.close }));
vi.mock('node:process', () => ({ default: { getuid: () => 1000 } }));
const file = () => ({
  isFile: () => true,
  uid: 1000n,
  mode: 0o100600n,
  nlink: 1n,
  size: 0n,
  dev: 1n,
  ino: 2n,
  birthtimeNs: 3n,
  mtimeNs: 4n,
});
beforeEach(() => {
  io.stat.mockReset();
  io.write.mockReset();
  io.close.mockReset();
  io.stat.mockImplementation(file);
  io.write.mockImplementation((_fd, bytes) => bytes.length);
});

it('performs no file operation when terminal observation is absent', () => {
  expect(createTerminalCleanupReceipt()({ kind: 'cleaned-owned' })).toBe(false);
  expect(io.stat).not.toHaveBeenCalled();
  expect(io.write).not.toHaveBeenCalled();
  expect(io.close).not.toHaveBeenCalled();
});

it('publishes one bounded existing cleanup observation and strips unrelated fields', () => {
  const publish = createTerminalCleanupReceipt(31);
  const actual = {
    kind: 'cleaned-owned' as const,
    anchorClose: { code: 0, signal: null },
    unrelated: 'excluded',
  };
  expect(publish(actual)).toBe(true);
  expect(publish({ kind: 'cleanup-uncertain' })).toBe(false);
  expect(io.write).toHaveBeenCalledTimes(1);
  expect(io.close).toHaveBeenCalledExactlyOnceWith(31);
  const [fd, bytes, offset, length, position] = io.write.mock.calls[0]!;
  expect(fd).toBe(31);
  expect(bytes.length).toBeLessThanOrEqual(512);
  expect(bytes.toString()).toBe(
    '{"version":1,"kind":"cleaned-owned","anchorClose":{"code":0,"signal":null}}\n'
  );
  expect([offset, length, position]).toEqual([0, bytes.length, 0]);
});

it.each(['never-acquired', 'cleanup-uncertain'] as const)(
  'preserves existing %s outcome',
  (kind) => {
    expect(createTerminalCleanupReceipt(31)({ kind })).toBe(true);
    expect(JSON.parse(io.write.mock.calls[0]![1].toString())).toEqual({ version: 1, kind });
  }
);

it('refuses an occupied or replaced output without writing or retrying', () => {
  const publish = createTerminalCleanupReceipt(31);
  io.stat.mockReturnValue({ ...file(), ino: 9n });
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
  expect(io.write).not.toHaveBeenCalled();
  expect(io.close).toHaveBeenCalledTimes(1);
});

it('rejects a nonprivate descriptor before observation can be armed', () => {
  io.stat.mockReturnValue({ ...file(), mode: 0o100644n });
  expect(() => createTerminalCleanupReceipt(31)).toThrow('empty owned private file');
  expect(io.write).not.toHaveBeenCalled();
});

it('keeps partial-write failure silent and makes no second publication attempt', () => {
  io.write.mockReturnValue(1);
  const publish = createTerminalCleanupReceipt(31);
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
  expect(io.write).toHaveBeenCalledTimes(1);
});

it('contains write and close failures without changing the existing cleanup result', () => {
  io.write.mockImplementation(() => {
    throw new Error('fixture output unavailable');
  });
  io.close.mockImplementation(() => {
    throw new Error('fixture close unavailable');
  });
  const publish = createTerminalCleanupReceipt(31);
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
  expect(io.write).toHaveBeenCalledTimes(1);
});

it('publishes nothing before a terminal outcome is supplied', () => {
  createTerminalCleanupReceipt(31);
  expect(io.write).not.toHaveBeenCalled();
  expect(io.close).not.toHaveBeenCalled();
});

it('refuses oversized or invalid terminal fields without copying them', () => {
  const publish = createTerminalCleanupReceipt(31);
  expect(
    publish({ kind: 'cleaned-owned', anchorClose: { code: 0, signal: 'SIG' + 'X'.repeat(600) } })
  ).toBe(false);
  expect(io.write).not.toHaveBeenCalled();
  expect(publish({ kind: 'cleaned-owned' })).toBe(false);
});
