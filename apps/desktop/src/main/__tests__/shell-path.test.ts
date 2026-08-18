import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => import('./electron-mock'));
vi.mock('electron-log', () => import('./electron-log-mock'));
vi.mock('node:child_process', () => import('./child-process-mock'));

/**
 * `vi.mock(..., factory)` memoizes its result for the whole test file, so mock
 * state is fetched through the real specifier rather than by importing the mock
 * module directly — `vi.resetModules()` re-evaluates the module under test but
 * never re-invokes a mock factory.
 */
async function getElectronMock() {
  const electron = await import('electron');
  return electron as unknown as typeof import('./electron-mock');
}

async function getChildProcessMock() {
  const childProcess = await import('node:child_process');
  return childProcess as unknown as typeof import('./child-process-mock');
}

async function getLogMock() {
  const electronLog = await import('electron-log');
  return electronLog as unknown as typeof import('./electron-log-mock');
}

/** The PATH a Finder- or Dock-launched app inherits from launchd. */
const LAUNCHD_PATH = '/usr/bin:/bin:/usr/sbin:/sbin';

/** A plausible login-shell PATH: the launchd four, plus where people's tools live. */
const LOGIN_PATH = `/Users/kai/.local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;

/**
 * Everything a login shell wrote to stdout for a given PATH, marker and all.
 *
 * Built from the module's own marker rather than a copy of it, and deliberately
 * surrounded by noise: an interactive shell prints whatever the user's rc files
 * print (version notices, `fortune`, a direnv banner), and the parser has to
 * survive that — which is the reason the marker exists.
 */
async function shellStdout(pathValue: string, { noise = true } = {}): Promise<string> {
  const { LOGIN_SHELL_PATH_MARKER } = await import('../../shared/login-shell-path');
  const before = noise ? 'nvm: using node v22.14.0\n' : '';
  const after = noise ? '\n(anaconda3) ' : '';
  return `${before}${LOGIN_SHELL_PATH_MARKER}${pathValue}${LOGIN_SHELL_PATH_MARKER}${after}`;
}

beforeEach(async () => {
  vi.resetModules();
  const { app, resetElectronMock } = await getElectronMock();
  const { resetChildProcessMock } = await getChildProcessMock();
  const { resetLogMock } = await getLogMock();
  resetElectronMock();
  resetChildProcessMock();
  resetLogMock();
  app.isPackaged = true;
  vi.stubEnv('SHELL', '/bin/zsh');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('resolveChildPath', () => {
  it('puts the login shell PATH in front of what launchd handed the app', async () => {
    // The bug this fixes: a Finder launch inherits launchd's four system
    // directories, so every `which claude` / `which codex` rung in the server
    // failed for anything installed under ~/.local/bin or /opt/homebrew/bin.
    const { spawnSync } = await getChildProcessMock();
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: await shellStdout(LOGIN_PATH),
      stderr: '',
    });
    const { resolveChildPath } = await import('../shell-path');

    expect(resolveChildPath(LAUNCHD_PATH)).toBe(LOGIN_PATH);
  });

  it('keeps inherited entries the login shell did not mention, after the resolved ones', async () => {
    const { spawnSync } = await getChildProcessMock();
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: await shellStdout('/opt/homebrew/bin:/usr/bin'),
      stderr: '',
    });
    const { resolveChildPath } = await import('../shell-path');

    // /usr/bin appears in both and must not be duplicated; /sbin is only in the
    // inherited PATH and must survive.
    expect(resolveChildPath('/usr/bin:/sbin')).toBe('/opt/homebrew/bin:/usr/bin:/sbin');
  });

  it('asks the login shell interactively, because that is where people export PATH', async () => {
    const { spawnSync } = await getChildProcessMock();
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: await shellStdout(LOGIN_PATH),
      stderr: '',
    });
    const { resolveChildPath } = await import('../shell-path');
    const { LOGIN_SHELL_PATH_MARKER } = await import('../../shared/login-shell-path');

    resolveChildPath(LAUNCHD_PATH);

    const [command, args, options] = spawnSync.mock.calls[0];
    expect(command).toBe('/bin/zsh');
    // `-i` is load-bearing: plenty of people export PATH in ~/.zshrc, which a
    // non-interactive login shell never reads.
    expect(args).toEqual(['-ilc', expect.stringContaining(LOGIN_SHELL_PATH_MARKER)]);
    expect(args[1]).toContain('${PATH}');
    // Bounded, and killed outright if it hangs: an rc file that waits for input
    // must not be able to stop the app from starting.
    expect(options).toMatchObject({ killSignal: 'SIGKILL', encoding: 'utf8' });
    expect(options.timeout).toBeGreaterThan(0);
  });

  it('asks the shell once per process, however many times the server is spawned', async () => {
    // The server child is re-spawned on every crash recovery; paying a shell
    // start-up for each one would add seconds to a restart.
    const { spawnSync } = await getChildProcessMock();
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: await shellStdout(LOGIN_PATH),
      stderr: '',
    });
    const { resolveChildPath } = await import('../shell-path');

    resolveChildPath(LAUNCHD_PATH);
    resolveChildPath(LAUNCHD_PATH);
    resolveChildPath(LAUNCHD_PATH);

    expect(spawnSync).toHaveBeenCalledTimes(1);
  });

  it('ignores whatever the rc files wrote to stderr', async () => {
    const { spawnSync } = await getChildProcessMock();
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: await shellStdout(LOGIN_PATH),
      stderr: 'zsh: no matches found: ~/.iterm2_shell_integration.*\n',
    });
    const { resolveChildPath } = await import('../shell-path');

    expect(resolveChildPath(LAUNCHD_PATH)).toBe(LOGIN_PATH);
  });

  it('parses a shell that printed nothing but the PATH', async () => {
    const { spawnSync } = await getChildProcessMock();
    spawnSync.mockReturnValue({
      status: 0,
      signal: null,
      stdout: await shellStdout(LOGIN_PATH, { noise: false }),
      stderr: '',
    });
    const { resolveChildPath } = await import('../shell-path');

    expect(resolveChildPath(LAUNCHD_PATH)).toBe(LOGIN_PATH);
  });

  describe('falls back to the inherited PATH', () => {
    /** Assert the fallback happened, and that it said so out loud. */
    async function expectFallbackWithWarning(): Promise<void> {
      const { resolveChildPath } = await import('../shell-path');
      const { default: log } = await getLogMock();

      expect(resolveChildPath(LAUNCHD_PATH)).toBe(LAUNCHD_PATH);
      expect(log.warn).toHaveBeenCalled();
    }

    it('when the shell could not be started at all', async () => {
      const { spawnSync } = await getChildProcessMock();
      spawnSync.mockReturnValue({
        status: null,
        signal: null,
        stdout: '',
        stderr: '',
        error: new Error('spawnSync /bin/zsh ENOENT'),
      });

      await expectFallbackWithWarning();
    });

    it('when the shell hung and was killed', async () => {
      const { spawnSync } = await getChildProcessMock();
      spawnSync.mockReturnValue({
        status: null,
        signal: 'SIGKILL',
        stdout: '',
        stderr: '',
        error: new Error('spawnSync /bin/zsh ETIMEDOUT'),
      });

      await expectFallbackWithWarning();
    });

    it('when the shell exited non-zero', async () => {
      const { spawnSync } = await getChildProcessMock();
      spawnSync.mockReturnValue({ status: 127, signal: null, stdout: '', stderr: 'nope' });

      await expectFallbackWithWarning();
    });

    it('when the output carries no marked PATH', async () => {
      const { spawnSync } = await getChildProcessMock();
      spawnSync.mockReturnValue({
        status: 0,
        signal: null,
        stdout: 'Welcome to your shell!\n',
        stderr: '',
      });

      await expectFallbackWithWarning();
    });

    it('when what came back does not look like a PATH', async () => {
      // A shell that printed an empty or relative-only PATH is a shell whose
      // answer would make things worse than launchd's four directories.
      const { spawnSync } = await getChildProcessMock();
      spawnSync.mockReturnValue({
        status: 0,
        signal: null,
        stdout: await shellStdout('node_modules/.bin:'),
        stderr: '',
      });

      await expectFallbackWithWarning();
    });

    it('when $SHELL is not set', async () => {
      vi.stubEnv('SHELL', '');

      await expectFallbackWithWarning();

      const { spawnSync } = await getChildProcessMock();
      expect(spawnSync).not.toHaveBeenCalled();
    });
  });

  describe('does not ask a shell at all', () => {
    it('in dev, where the terminal PATH is already inherited', async () => {
      const { app } = await getElectronMock();
      app.isPackaged = false;
      const { spawnSync } = await getChildProcessMock();
      const { resolveChildPath } = await import('../shell-path');
      const { default: log } = await getLogMock();

      expect(resolveChildPath(LAUNCHD_PATH)).toBe(LAUNCHD_PATH);
      expect(spawnSync).not.toHaveBeenCalled();
      // Skipping on purpose is not a fault; it must not read as one in the log.
      expect(log.warn).not.toHaveBeenCalled();
    });

    it('on Windows, which has no login-shell PATH to read', async () => {
      const original = process.platform;
      Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
      try {
        const { spawnSync } = await getChildProcessMock();
        const { resolveChildPath } = await import('../shell-path');
        const { default: log } = await getLogMock();

        expect(resolveChildPath(LAUNCHD_PATH)).toBe(LAUNCHD_PATH);
        expect(spawnSync).not.toHaveBeenCalled();
        expect(log.warn).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
      }
    });
  });
});
