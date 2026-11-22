import { describe, expect, it } from 'vitest';
import { projectRuntimeEnvironment, type EnvironmentRuntime } from '../runtime-environment.js';

const RUNTIMES: readonly EnvironmentRuntime[] = ['claude-code', 'codex', 'opencode', 'doe'];
const PURPOSES = ['turn', 'warmup', 'auth-probe', 'locator', 'provision'] as const;

describe('runtime children honour DO_NOT_TRACK (DOR-4990)', () => {
  it.each([
    ['DO_NOT_TRACK', '1'],
    ['DO_NOT_TRACK', 'true'],
    ['DORKOS_TELEMETRY_DISABLED', '1'],
    ['DORKOS_TELEMETRY_DISABLED', 'TRUE'],
  ])('%s=%s sets DO_NOT_TRACK=1 and DISABLE_TELEMETRY=1 on every runtime child', (name, value) => {
    for (const runtime of RUNTIMES)
      for (const purpose of PURPOSES) {
        const result = projectRuntimeEnvironment({
          parent: { PATH: '/synthetic/bin', [name]: value },
          runtime,
          purpose,
          platform: 'linux',
        });
        expect(result).toMatchObject({ DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1' });
        // The DorkOS-scoped switch itself is not passed on; only the two names are.
        expect(result).not.toHaveProperty('DORKOS_TELEMETRY_DISABLED');
      }
  });

  it.each(RUNTIMES)(
    '%s: an inherited or overridden value cannot turn telemetry back on',
    (runtime) => {
      const result = projectRuntimeEnvironment({
        parent: { DORKOS_TELEMETRY_DISABLED: '1', DO_NOT_TRACK: '0', DISABLE_TELEMETRY: '0' },
        runtime,
        purpose: 'turn',
        overrides: { DO_NOT_TRACK: '0' },
        platform: 'linux',
      });
      expect(result.DO_NOT_TRACK).toBe('1');
      expect(result.DISABLE_TELEMETRY).toBe('1');
    }
  );

  it('matches the switch case-insensitively on Windows and emits one spelling', () => {
    const result = projectRuntimeEnvironment({
      parent: { Do_Not_Track: '1', Path: 'C:\\synthetic' },
      runtime: 'codex',
      purpose: 'turn',
      platform: 'win32',
    });
    expect(result).toEqual({ Path: 'C:\\synthetic', DO_NOT_TRACK: '1', DISABLE_TELEMETRY: '1' });
  });

  it.each([undefined, '0', 'false', ''])('adds nothing when the switches are %j', (value) => {
    for (const runtime of RUNTIMES) {
      const result = projectRuntimeEnvironment({
        parent: { PATH: '/synthetic/bin', DORKOS_TELEMETRY_DISABLED: value },
        runtime,
        purpose: 'locator',
        platform: 'linux',
      });
      expect(result).toEqual({ PATH: '/synthetic/bin' });
    }
  });
});
