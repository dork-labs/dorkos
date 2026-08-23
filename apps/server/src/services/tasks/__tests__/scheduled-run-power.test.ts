/**
 * The unattended-power ladder for scheduled runs (spec `full-power-defaults`,
 * D6).
 *
 * The config section and the capability profile are passed in rather than
 * mocked: the resolver's whole job is turning a stored stop into the mode id the
 * runtime that will execute the run calls it, and handing it both is the most
 * direct way to ask what it does with each shape. The profiles are the real
 * shipped ones, so a change to Claude Code's declared order shows up here rather
 * than in production.
 */
import { describe, it, expect } from 'vitest';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../../runtimes/test-mode/runtime-constants.js';
import {
  resolveScheduledRunPermissionMode,
  SCHEDULED_RUN_FALLBACK_MODE,
} from '../scheduled-run-power.js';

/** The stored `runtimes` block, with one section's fields replaced. */
function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

describe('resolveScheduledRunPermissionMode', () => {
  it('is exactly acceptEdits when nothing is configured', () => {
    // The byte-for-byte regression. Anyone who never answered the power door
    // gets what every scheduled run has always got, and this is the assertion
    // that says so — a value, not a variable.
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes(),
      })
    ).toBe('acceptEdits');
    expect(SCHEDULED_RUN_FALLBACK_MODE).toBe('acceptEdits');
  });

  it("lands on the runtime's own autonomy mode when the operator is at full power", () => {
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toBe('bypassPermissions');
  });

  it('honours the first-declared rule where a runtime declares two modes at one stop', () => {
    // Claude Code declares `acceptEdits` before `auto` at the `act` stop, and
    // the resolved default has to be the one the dial would show as selected —
    // which is `resolveTrustStops`'s answer, never a second mapping here.
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({ defaultTrustStop: 'act' }),
      })
    ).toBe('acceptEdits');
  });

  it('asks first when that is what the operator chose', () => {
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({ defaultTrustStop: 'ask' }),
      })
    ).toBe('default');
  });

  it("lets the runtime's own override beat the global stop", () => {
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({
          defaultTrustStop: 'autonomy',
          claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultTrustStop: 'ask' },
        }),
      })
    ).toBe('default');
  });

  it('falls back when the target runtime is not registered at all', () => {
    // A test-mode boot, and any boot where claude-code failed to register. No
    // profile means no way to name a mode, and guessing one would be worse than
    // the constant.
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: undefined,
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toBe('acceptEdits');
  });

  it('falls back for a runtime that declares no mode at the configured stop', () => {
    const noAutonomy = {
      ...CLAUDE_CODE_CAPABILITIES,
      permissionModes: {
        ...CLAUDE_CODE_CAPABILITIES.permissionModes,
        values: CLAUDE_CODE_CAPABILITIES.permissionModes.values.filter(
          (mode) => mode.stop !== 'autonomy'
        ),
      },
    };

    expect(
      resolveScheduledRunPermissionMode({
        capabilities: noAutonomy,
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toBe('acceptEdits');
  });

  it('still reads the global stop for a runtime with no config section of its own', () => {
    // `test-mode` declares `configSection: null`. The stop is runtime-neutral,
    // so it still applies; the mode id is whatever that runtime calls it.
    expect(TEST_MODE_CAPABILITIES.settings.configSection).toBeNull();
    expect(
      resolveScheduledRunPermissionMode({
        capabilities: TEST_MODE_CAPABILITIES,
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toBe('always-allow');
  });

  it('falls back before the config manager has booted', () => {
    // `configManager` is a `let` that is undefined until `initConfigManager`
    // runs, and nothing here initialises it. A scheduled run must still start.
    expect(resolveScheduledRunPermissionMode({ capabilities: CLAUDE_CODE_CAPABILITIES })).toBe(
      'acceptEdits'
    );
  });
});
