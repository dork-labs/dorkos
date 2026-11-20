/**
 * Quitting the person's sign-in Chrome on a Mac (DOR-4731). SIGTERM ends it without writing
 * its newest cookies, so a Mac gets the quit ⌘Q sends, aimed at that one process. Nothing here
 * launches Chrome or runs osascript: the child and the runner are fakes.
 */
import { describe, expect, it, vi } from 'vitest';
import { MAC_QUIT_SCRIPT, OSASCRIPT, macQuitArgs, quitPlainChild } from '../connection/mac-quit.js';

function child(overrides: { exitCode?: number | null; signalCode?: NodeJS.Signals | null } = {}) {
  return {
    pid: 4242,
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null,
    kill: vi.fn(() => true),
    ...overrides,
  };
}

describe('macQuitArgs', () => {
  it('runs one fixed script, with the pid and the binary as plain arguments', () => {
    const args = macQuitArgs(4242, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    expect(args).toEqual([
      '-l',
      'JavaScript',
      '-e',
      MAC_QUIT_SCRIPT,
      '4242',
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    ]);
    // Nothing is ever written into the script itself.
    expect(macQuitArgs(7, '/x')[3]).toBe(MAC_QUIT_SCRIPT);
  });

  it('refuses anything but a positive whole pid', () => {
    for (const pid of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
      expect(() => macQuitArgs(pid, '/x')).toThrow();
  });

  it('checks the pid and the binary inside the script before it quits anything', () => {
    expect(MAC_QUIT_SCRIPT).toContain('runningApplicationWithProcessIdentifier');
    expect(MAC_QUIT_SCRIPT).toContain('processIdentifier');
    expect(MAC_QUIT_SCRIPT).toContain('executableURL');
    // The quit comes last, after every check.
    expect(MAC_QUIT_SCRIPT.lastIndexOf('terminate')).toBeGreaterThan(
      MAC_QUIT_SCRIPT.lastIndexOf('executableURL')
    );
    // No name or bundle id: only the pid it was given.
    expect(MAC_QUIT_SCRIPT).not.toMatch(/Application\(|bundleIdentifier|com\.google/);
  });
});

describe('quitPlainChild', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

  it('on a Mac, asks that one process to quit the way ⌘Q does, never by a signal', () => {
    const run = vi.fn();
    const window = child();
    quitPlainChild(window, chrome, 'darwin', run);
    expect(run).toHaveBeenCalledExactlyOnceWith(OSASCRIPT, macQuitArgs(4242, chrome));
    expect(OSASCRIPT).toBe('/usr/bin/osascript');
    expect(window.kill).not.toHaveBeenCalled();
  });

  it('sends nothing to a child that already ended', () => {
    const run = vi.fn();
    for (const ended of [child({ exitCode: 0 }), child({ signalCode: 'SIGTERM' })]) {
      quitPlainChild(ended, chrome, 'darwin', run);
      quitPlainChild(ended, chrome, 'linux', run);
      expect(ended.kill).not.toHaveBeenCalled();
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps the Windows close request unchanged', () => {
    const run = vi.fn();
    const window = child();
    quitPlainChild(window, 'C:\\Chrome\\chrome.exe', 'win32', run);
    expect(run).toHaveBeenCalledExactlyOnceWith('taskkill', ['/PID', '4242']);
    expect(window.kill).not.toHaveBeenCalled();
  });

  it('keeps SIGTERM on Linux', () => {
    const run = vi.fn();
    const window = child();
    quitPlainChild(window, chrome, 'linux', run);
    expect(window.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM');
    expect(run).not.toHaveBeenCalled();
  });
});
