import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { chmod, lstat, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { openPosixGuardian } from '../run-custody/posix/host.mjs';

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), stat: vi.fn(), uid: 0 }));
vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:fs', () => ({ fstatSync: mocks.stat, writeSync: vi.fn(), closeSync: vi.fn() }));
vi.mock('node:process', () => ({
  default: { platform: 'linux', execPath: '/fixture/node', getuid: () => mocks.uid },
}));

let directory: string;
const children: Array<EventEmitter & { stdin: PassThrough; stdout: PassThrough }> = [];
beforeEach(async () => {
  vi.clearAllMocks();
  directory = await realpath(await mkdtemp(join(tmpdir(), 'dork-receipt-host-')));
  await chmod(directory, 0o700);
  mocks.uid = (await lstat(directory)).uid;
  mocks.stat.mockReturnValue({
    isFile: () => true,
    uid: BigInt(mocks.uid),
    mode: 0o100600n,
    nlink: 1n,
    size: 0n,
  });
  mocks.spawn.mockImplementation(() => {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
    });
    children.push(child);
    queueMicrotask(() => child.stdout.write('ready\n'));
    return child;
  });
});
afterEach(async () => {
  for (const child of children.splice(0)) {
    child.stdin.destroy();
    child.stdout.destroy();
    child.emit('close', 0, null);
  }
  if (directory) await rm(directory, { recursive: true });
});

it('keeps the default argv, environment and three descriptors unchanged', async () => {
  await openPosixGuardian({ directory, signal: new AbortController().signal });
  const [node, argv, options] = mocks.spawn.mock.calls[0]!;
  expect(node).toBe('/fixture/node');
  expect(argv).toHaveLength(3);
  expect(argv[1]).toBe(directory);
  expect(options).toEqual({ shell: false, stdio: ['pipe', 'pipe', 'ignore'], env: {} });
  expect(mocks.stat).not.toHaveBeenCalled();
});

it('duplicates only the supplied owned output into a fixed guardian descriptor', async () => {
  await openPosixGuardian({
    directory,
    observer: '/fixture/observer',
    signal: new AbortController().signal,
    terminalCleanupReceiptFd: 31,
  });
  const [, argv, options] = mocks.spawn.mock.calls[0]!;
  expect(argv.slice(-2)).toEqual(['/fixture/observer', '--fixture-terminal-cleanup-fd=3']);
  expect(options.stdio).toEqual(['pipe', 'pipe', 'ignore', 31]);
  expect(options.env).toEqual({});
  expect(mocks.stat).toHaveBeenCalledExactlyOnceWith(31, { bigint: true });
});

it('refuses an invalid descriptor before any guardian spawn', async () => {
  mocks.stat.mockReturnValue({ isFile: () => false });
  await expect(
    openPosixGuardian({
      directory,
      signal: new AbortController().signal,
      terminalCleanupReceiptFd: 31,
    })
  ).rejects.toThrow('empty owned private file');
  expect(mocks.spawn).not.toHaveBeenCalled();
});

it('retains the real private-directory refusal before descriptor validation or spawn', async () => {
  await chmod(directory, 0o755);
  await expect(
    openPosixGuardian({
      directory,
      signal: new AbortController().signal,
      terminalCleanupReceiptFd: 31,
    })
  ).rejects.toThrow('not owner-private');
  expect(mocks.stat).not.toHaveBeenCalled();
  expect(mocks.spawn).not.toHaveBeenCalled();
});
