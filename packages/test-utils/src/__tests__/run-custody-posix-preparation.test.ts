import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildDarwinObserver, validateDarwinObserver } from '../run-custody/posix/darwin-build.mjs';
import { allocatePosixSocketDirectory } from '../run-custody/posix/socket-directory.mjs';

async function fixture(run: (parent: string) => Promise<void>) {
  const parent = await mkdtemp(join(await realpath('/tmp'), 'dork-posix-'));
  try {
    await run(parent);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
}

function fixtureImage(arm = true) {
  const bytes = Buffer.alloc(32);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(arm ? 0x0100000c : 0x01000007, 4);
  bytes.writeUInt32LE(2, 12);
  return bytes;
}

describe.skipIf(process.platform === 'win32')('private POSIX preparation', () => {
  it('keeps an owned socket path short and preserves nonempty or replaced directories', async () => {
    await fixture(async (parent) => {
      const owned = await allocatePosixSocketDirectory(parent);
      const actual = await lstat(owned.directory, { bigint: true });
      expect(owned.identity).toEqual({
        device: actual.dev.toString(),
        inode: actual.ino.toString(),
      });
      expect(actual.mode & 0o777n).toBe(0o700n);
      expect(Buffer.byteLength(join(owned.directory, `${'a'.repeat(32)}.sock`))).toBeLessThan(104);
      const marker = join(owned.directory, 'retained');
      await writeFile(marker, 'fixture');
      expect(await owned.remove()).toBe('cleanup-uncertain');
      await rm(marker);
      expect(await owned.remove()).toBe('closed');

      const replaced = await allocatePosixSocketDirectory(parent);
      await rename(replaced.directory, join(parent, 'original'));
      await mkdir(replaced.directory, { mode: 0o700 });
      expect(await replaced.remove()).toBe('cleanup-uncertain');
      expect(await readdir(parent)).toContain('original');
    });
  });

  it('refuses a long socket name before allocating it', async () => {
    await fixture(async (parent) => {
      const long = join(parent, 'long'.repeat(25));
      await mkdir(long, { mode: 0o700 });
      await expect(allocatePosixSocketDirectory(long)).rejects.toThrow(/pathname/);
      expect(await readdir(long)).toEqual([]);
    });
  });

  it('records the exact explicit compiler steps and validates the resulting immutable-mode artifact', async () => {
    await fixture(async (parent) => {
      const run = vi.fn<NonNullable<Parameters<typeof buildDarwinObserver>[0]['run']>>(
        async (_command, args) => {
          if (args.includes('--find')) return '/fixture/clang';
          if (args.includes('--show-sdk-path')) return '/fixture/sdk';
          if (args.includes('--show-sdk-version')) return '15.0';
          if (args.includes('--version')) return 'fixture compiler';
          await writeFile(args.at(-1)!, fixtureImage(), { flag: 'wx' });
          return '';
        }
      );
      const options = { parent, platform: 'darwin' as const, arch: 'arm64' as const, run };
      const built = await buildDarwinObserver(options);
      expect(run.mock.calls.map(([name]) => name)).toEqual([
        '/usr/bin/xcrun',
        '/usr/bin/xcrun',
        '/fixture/clang',
        '/usr/bin/xcrun',
        '/fixture/clang',
      ]);
      expect(run.mock.calls[4]![1]).toEqual([
        '-std=c11',
        '-Wall',
        '-Wextra',
        '-Werror',
        '-arch',
        'arm64',
        '-isysroot',
        '/fixture/sdk',
        expect.stringMatching(/\/native\/darwin-observer\.c$/),
        '-o',
        expect.stringMatching(/\/darwin-observer$/),
      ]);
      const prepared = {
        directory: built.directory,
        manifestSha256: built.manifestSha256,
        platform: options.platform,
        arch: options.arch,
      };
      const artifact = await validateDarwinObserver(prepared);
      expect(artifact.sha256).toBe(built.artifactSha256);
      expect((await lstat(artifact.path)).mode & 0o777).toBe(0o500);
      await expect(
        validateDarwinObserver({ ...prepared, manifestSha256: '0'.repeat(64) })
      ).rejects.toThrow(/manifest digest/);
      await chmod(artifact.path, 0o700);
      await expect(validateDarwinObserver(prepared)).rejects.toThrow(/mode/);
      const changed = Buffer.concat([fixtureImage(), Buffer.of(42)]);
      await writeFile(artifact.path, changed);
      await chmod(artifact.path, 0o500);
      await expect(validateDarwinObserver(prepared)).rejects.toThrow(/differs/);
    });
  });

  it('never starts a compiler for unsupported or cancelled preparation', async () => {
    await fixture(async (parent) => {
      const run = vi.fn<NonNullable<Parameters<typeof buildDarwinObserver>[0]['run']>>();
      await expect(
        buildDarwinObserver({ parent, platform: 'linux', arch: 'arm64', run })
      ).rejects.toThrow(/unsupported/);
      const controller = new AbortController();
      controller.abort();
      await expect(
        buildDarwinObserver({
          parent,
          platform: 'darwin',
          arch: 'arm64',
          run,
          signal: controller.signal,
        })
      ).rejects.toThrow(/cancelled/);
      expect(run).not.toHaveBeenCalled();
      expect(await readdir(parent)).toEqual([]);
    });
  });
});
