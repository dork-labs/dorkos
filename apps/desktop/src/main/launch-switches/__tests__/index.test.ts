import { describe, it, expect } from 'vitest';
import { REFUSED_LAUNCH_SWITCHES, findRefusedLaunchSwitch } from '../index';

const EXE = '/Applications/DorkOS.app/Contents/MacOS/DorkOS';

/** A command line that reports nothing, so only the argv scan can answer. */
const emptyCommandLine = {
  hasSwitch: () => false,
  getSwitchValue: () => '',
};

/** A command line that reports the given switches, as Chromium parsed them. */
function commandLineWith(switches: Record<string, string>) {
  return {
    hasSwitch: (name: string) => name in switches,
    getSwitchValue: (name: string) => switches[name] ?? '',
  };
}

describe('findRefusedLaunchSwitch', () => {
  it.each(REFUSED_LAUNCH_SWITCHES)('refuses --%s on its own', (name) => {
    expect(findRefusedLaunchSwitch([EXE, `--${name}`], emptyCommandLine, 'darwin')).toBe(name);
  });

  it.each(REFUSED_LAUNCH_SWITCHES)('refuses --%s=<value>', (name) => {
    expect(findRefusedLaunchSwitch([EXE, `--${name}=0`], emptyCommandLine, 'darwin')).toBe(name);
  });

  it.each(REFUSED_LAUNCH_SWITCHES)(
    'refuses %s when only the parsed command line has it',
    (name) => {
      expect(findRefusedLaunchSwitch([EXE], commandLineWith({ [name]: '' }), 'darwin')).toBe(name);
    }
  );

  it('refuses the single-dash form Chromium also accepts', () => {
    expect(
      findRefusedLaunchSwitch([EXE, '-remote-debugging-port=0'], emptyCommandLine, 'darwin')
    ).toBe('remote-debugging-port');
  });

  it('ignores case, so a differently cased switch is still refused', () => {
    expect(
      findRefusedLaunchSwitch([EXE, '--Remote-Debugging-Port=0'], emptyCommandLine, 'darwin')
    ).toBe('remote-debugging-port');
  });

  it('refuses the slash form on Windows only', () => {
    const argv = ['C:\\DorkOS\\DorkOS.exe', '/remote-debugging-port=0'];
    expect(findRefusedLaunchSwitch(argv, emptyCommandLine, 'win32')).toBe('remote-debugging-port');
    expect(findRefusedLaunchSwitch(argv, emptyCommandLine, 'darwin')).toBeNull();
  });

  it('refuses --js-flags that carry an inspector flag', () => {
    expect(
      findRefusedLaunchSwitch([EXE, '--js-flags=--expose-gc --inspect'], emptyCommandLine, 'darwin')
    ).toBe('js-flags');
    expect(
      findRefusedLaunchSwitch([EXE], commandLineWith({ 'js-flags': '--inspect-brk' }), 'darwin')
    ).toBe('js-flags');
  });

  it('allows --js-flags that carry no inspector flag', () => {
    expect(
      findRefusedLaunchSwitch([EXE, '--js-flags=--expose-gc'], emptyCommandLine, 'darwin')
    ).toBeNull();
    expect(
      findRefusedLaunchSwitch(
        [EXE],
        commandLineWith({ 'js-flags': '--max-old-space-size=4096' }),
        'darwin'
      )
    ).toBeNull();
  });

  it('allows an ordinary launch, a deep link and unrelated switches', () => {
    const argv = [EXE, '--enable-logging', '--lang=en', 'dorkos://session?id=7', '/tmp/inspect'];
    expect(findRefusedLaunchSwitch(argv, emptyCommandLine, 'darwin')).toBeNull();
  });

  it('does not mistake a switch that merely starts with a refused name', () => {
    expect(
      findRefusedLaunchSwitch([EXE, '--inspector-theme=dark'], emptyCommandLine, 'darwin')
    ).toBeNull();
  });

  it('never reads the executable path as a switch', () => {
    expect(findRefusedLaunchSwitch(['--inspect'], emptyCommandLine, 'darwin')).toBeNull();
  });
});
