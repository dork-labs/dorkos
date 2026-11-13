import { beforeEach, describe, expect, it, vi } from 'vitest';

const dispatcher = vi.hoisted(() => ({ run: vi.fn(async () => 0) }));
vi.mock('../../commands/browser-dispatcher.js', () => ({ runBrowserDispatcher: dispatcher.run }));
vi.stubGlobal('__CLI_VERSION__', '9.9.9-made-up');

const { runTerminalCommand, TERMINAL_COMMAND_HELP } = await import('../terminal-command.js');

function capture() {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: { log: (text: string) => lines.push(text), error: (text: string) => errors.push(text) },
  };
}

beforeEach(() => dispatcher.run.mockClear());

describe('the Mac app’s Terminal command', () => {
  it('hands browser commands to the CLI’s own browser dispatcher', async () => {
    const { out } = capture();
    expect(await runTerminalCommand(['browser', 'login', 'made-up.example'], out)).toBe(0);
    expect(dispatcher.run).toHaveBeenCalledWith('login', ['made-up.example']);
  });

  it('prints the app’s version', async () => {
    const { out, lines } = capture();
    expect(await runTerminalCommand(['--version'], out)).toBe(0);
    expect(lines).toEqual(['9.9.9-made-up']);
  });

  it('prints help with no command', async () => {
    const { out, lines } = capture();
    expect(await runTerminalCommand([], out)).toBe(0);
    expect(lines).toEqual([TERMINAL_COMMAND_HELP]);
  });

  // A plain `dorkos` start beside the running app would be a second server.
  it('never starts DorkOS, and names the full command line for anything else', async () => {
    const { out, errors } = capture();
    expect(await runTerminalCommand(['start'], out)).toBe(1);
    expect(errors.join('\n')).toContain("has no 'start' command");
    expect(errors.join('\n')).toContain('npm install -g dorkos');
    expect(dispatcher.run).not.toHaveBeenCalled();
  });
});
