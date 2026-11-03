import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserStatePaths, parseBrowserState, scanBrowserProfiles } from '../profile-scan.js';

// Keep real file operations, with configurable exports for the file-access spies.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
}));

const state = (info_cache: unknown) => JSON.stringify({ profile: { info_cache } });
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('tap-only browser profile scan', () => {
  it('fullmatches directory names and ignores remote avatars and other fields', () => {
    const network = vi.spyOn(globalThis, 'fetch');
    expect(
      parseBrowserState(
        state({
          Default: {
            name: '<b>Work</b>',
            user_name: 'work@example.test',
            gaia_picture_file_name: 'https://example.test/avatar',
            password: 'secret',
          },
          'Profile 12': { name: 'Personal' },
          '../Profile 1': { name: 'Traversal' },
          'Profile 1/../../': { name: 'Traversal' },
          'Default\n': { name: 'Trailing newline' },
          'Profile 2\n': { name: 'Trailing newline' },
          'Profile ٣': { name: 'Not ASCII' },
          'System Profile': { name: 'System' },
        }),
        'chrome'
      )
    ).toEqual([
      {
        browser: 'chrome',
        directory: 'Default',
        displayName: '<b>Work</b>',
        email: 'work@example.test',
      },
      { browser: 'chrome', directory: 'Profile 12', displayName: 'Personal' },
    ]);
    expect(network).not.toHaveBeenCalled();
  });

  it('bounds display strings and strips control characters', () => {
    const [profile] = parseBrowserState(
      state({ Default: { name: '\u202e' + 'a'.repeat(200), user_name: 'a'.repeat(300) } }),
      'edge'
    );
    expect(profile.displayName).toBe('a'.repeat(120));
    expect(profile.email).toHaveLength(254);
  });

  it('opens only fixed Local State paths, and never enumerates a profile directory', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dorkos-scan-'));
    directories.push(home);
    const filenames = browserStatePaths(home, 'darwin');
    for (const filename of filenames) {
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(
        filename,
        state({ Default: { name: 'Work', user_name: 'person@example.test' } })
      );
      await writeFile(path.join(path.dirname(filename), 'Cookies'), 'must not read');
    }
    const open = vi.spyOn(fs, 'open');
    const readFile = vi.spyOn(fs, 'readFile');
    const readdir = vi.spyOn(fs, 'readdir');
    const result = await scanBrowserProfiles({ home, platform: 'darwin' });
    expect(result.profiles.map((profile) => profile.browser)).toEqual(['chrome', 'edge', 'brave']);
    expect(open.mock.calls.map(([filename]) => filename)).toEqual(filenames);
    expect(readFile).not.toHaveBeenCalled();
    expect(readdir).not.toHaveBeenCalled();
  });

  it('reports malformed, oversized and symlink metadata without exposing file details', async () => {
    const home = await mkdtemp(path.join(tmpdir(), 'dorkos-scan-'));
    directories.push(home);
    const filenames = browserStatePaths(home, 'darwin');
    for (const filename of filenames) await mkdir(path.dirname(filename), { recursive: true });
    await writeFile(filenames[0], '{not json');
    await writeFile(filenames[1], 'x'.repeat(2 * 1024 * 1024 + 1));
    await symlink(filenames[0], filenames[2]);
    const result = await scanBrowserProfiles({ home, platform: 'darwin' });
    expect(result).toEqual({
      supported: true,
      profiles: [],
      unreadable: ['chrome', 'edge', 'brave'],
    });
    expect(JSON.stringify(result)).not.toContain(home);
  });

  it('treats missing browsers as empty and never reads on unsupported platforms', async () => {
    const read = vi.fn().mockRejectedValue(Object.assign(new Error('missing'), { code: 'ENOENT' }));
    expect(await scanBrowserProfiles({ home: '/fixture', platform: 'darwin', read })).toEqual({
      supported: true,
      profiles: [],
      unreadable: [],
    });
    read.mockClear();
    expect(await scanBrowserProfiles({ platform: 'freebsd', read })).toEqual({
      supported: false,
      profiles: [],
      unreadable: [],
    });
    expect(read).not.toHaveBeenCalled();
  });
});
