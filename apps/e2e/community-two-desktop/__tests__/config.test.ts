import { describe, expect, it } from 'vitest';
import { OPT_IN_VARIABLE, readRunConfig } from '../config.js';

const mac = { os: 'darwin' as const, arch: 'arm64' };

describe('two-Desktop acceptance config', () => {
  it('refuses to run unless the opt-in variable is exactly 1', () => {
    for (const value of [undefined, '', '0', 'true', 'yes'])
      expect(() => readRunConfig({ [OPT_IN_VARIABLE]: value }, [], mac)).toThrow(/Refusing to run/);
  });

  it('runs once opted in, borrowing nothing and building nothing by default', () => {
    const config = readRunConfig({ [OPT_IN_VARIABLE]: '1' }, [], mac);
    expect(config.build).toBe(false);
    expect(config.postgresContainer).toBeNull();
    expect(config.executablePath).toMatch(
      /release\/mac-arm64\/DorkOS\.app\/Contents\/MacOS\/DorkOS$/
    );
  });

  it('builds when asked by flag or variable', () => {
    expect(readRunConfig({ [OPT_IN_VARIABLE]: '1' }, ['--build'], mac).build).toBe(true);
    expect(
      readRunConfig({ [OPT_IN_VARIABLE]: '1', DORKOS_TWO_DESKTOP_BUILD: '1' }, [], mac).build
    ).toBe(true);
  });

  it('refuses the default app path off macOS Apple Silicon unless an app is named', () => {
    const linux = { os: 'linux' as const, arch: 'x64' };
    expect(() => readRunConfig({ [OPT_IN_VARIABLE]: '1' }, [], linux)).toThrow(
      /DORKOS_TWO_DESKTOP_APP/
    );
    expect(
      readRunConfig(
        { [OPT_IN_VARIABLE]: '1', DORKOS_TWO_DESKTOP_APP: '/opt/dorkos/DorkOS' },
        [],
        linux
      ).executablePath
    ).toBe('/opt/dorkos/DorkOS');
  });
});
