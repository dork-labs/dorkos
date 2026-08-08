import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// `execFile` is callback-style; `promisify` (which the module under test calls
// at import time) wraps it, so the mock must invoke the callback. Hoisted
// because `vi.mock`'s factory runs before any top-level binding exists.
const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(
    (
      _file: string,
      _args: string[],
      options: unknown,
      callback?: (err: Error | null, stdout: string, stderr: string) => void
    ) => {
      const cb = (typeof options === 'function' ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string
      ) => void;
      cb(null, '', '');
    }
  ),
}));

vi.mock('node:child_process', () => ({ execFile: execFileMock }));

import { revealInFileManager } from '../reveal-in-file-manager.js';

const realPlatform = process.platform;

/** Pretend the server runs on `platform` for the duration of one test. */
function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

describe('revealInFileManager', () => {
  beforeEach(() => {
    execFileMock.mockClear();
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
  });

  it('selects the file in Finder on macOS', async () => {
    setPlatform('darwin');

    await revealInFileManager('/work/notes/todo.md');

    expect(execFileMock.mock.calls[0][0]).toBe('open');
    expect(execFileMock.mock.calls[0][1]).toEqual(['-R', '/work/notes/todo.md']);
  });

  it('selects the file in Explorer on Windows, quoting for verbatim arguments', async () => {
    setPlatform('win32');

    await revealInFileManager('C:\\work dir\\todo.md');

    expect(execFileMock.mock.calls[0][0]).toBe('explorer.exe');
    expect(execFileMock.mock.calls[0][1]).toEqual(['/select,"C:\\work dir\\todo.md"']);
    expect(execFileMock.mock.calls[0][2]).toEqual({ windowsVerbatimArguments: true });
  });

  /** Make the next execFile call fail with `code` on its callback. */
  function failNextWith(code: string | number, message: string): void {
    execFileMock.mockImplementationOnce((_file, _args, options, callback) => {
      const cb = (typeof options === 'function' ? options : callback) as (
        err: Error | null,
        stdout: string,
        stderr: string
      ) => void;
      cb(Object.assign(new Error(message), { code }), '', '');
    });
  }

  it('ignores the non-zero EXIT STATUS Explorer reports even on success', async () => {
    setPlatform('win32');
    failNextWith(1, 'Command failed');

    await expect(revealInFileManager('C:\\work\\todo.md')).resolves.toBeUndefined();
  });

  // The win32 branch used to swallow every error, so a launcher that never ran
  // reported success and the user watched for a window that was never opened.
  // Only a numeric exit status is Explorer's known lie; a string `code` is a
  // spawn failure and must surface.
  it('surfaces a Windows failure to spawn Explorer at all', async () => {
    setPlatform('win32');
    failNextWith('ENOENT', 'spawn explorer.exe ENOENT');

    await expect(revealInFileManager('C:\\work\\todo.md')).rejects.toThrow('ENOENT');
  });

  it('surfaces a Windows permission failure rather than reporting success', async () => {
    setPlatform('win32');
    failNextWith('EACCES', 'spawn explorer.exe EACCES');

    await expect(revealInFileManager('C:\\work\\todo.md')).rejects.toThrow('EACCES');
  });

  it('opens the containing folder on Linux, where nothing can be selected', async () => {
    setPlatform('linux');

    await revealInFileManager('/work/notes/todo.md');

    expect(execFileMock.mock.calls[0][0]).toBe('xdg-open');
    expect(execFileMock.mock.calls[0][1]).toEqual(['/work/notes']);
  });

  it('never passes the path through a shell', async () => {
    setPlatform('darwin');

    await revealInFileManager('/work/a; rm -rf b.md');

    // The path travels as one argv entry, so the `;` is data, not a separator.
    expect(execFileMock.mock.calls[0][1]).toEqual(['-R', '/work/a; rm -rf b.md']);
  });
});
