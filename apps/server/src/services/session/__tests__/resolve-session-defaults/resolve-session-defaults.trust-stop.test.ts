/** The trust stop a new or unattended session resolves to, in each runtime's own words. */
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { describe, it, expect } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../../../runtimes/test-mode/runtime-constants.js';
import {
  resolveUnattendedDefaultStop,
  resolveUnattendedPermissionMode,
} from '../../resolution/resolve-session-defaults.js';
import { runtimes, resolveForRuntime } from './resolve-session-defaults.fixtures.js';

describe('resolveSessionDefaults — the trust stop', () => {
  it('resolves a configured stop into the mode THAT runtime calls it', () => {
    const config = runtimes({ defaultTrustStop: 'act' });
    // Same stop, three different mode ids — which is the entire reason config
    // stores the stop and not the id.
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: config,
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'acceptEdits' });
    expect(
      resolveForRuntime({
        runtimeType: 'codex',
        runtimes: config,
        permissionModes: CODEX_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'acceptEdits' });
    expect(
      resolveForRuntime({
        runtimeType: 'test-mode',
        runtimes: config,
        permissionModes: TEST_MODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'scripted' });
  });

  it('never resolves a way of working — Plan sits at the ask stop but is not it', () => {
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'ask' }),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('default');
  });

  it('lets a per-runtime override beat the global stop', () => {
    const config = runtimes({
      defaultTrustStop: 'autonomy',
      codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'ask' },
    });
    expect(
      resolveForRuntime({
        runtimeType: 'codex',
        runtimes: config,
        permissionModes: CODEX_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'default' });
    // And leaves every runtime that did not override it on the global answer.
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: config,
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'bypassPermissions' });
  });

  it('resolves Full autonomy on a fresh install (ADR 261006-225605)', () => {
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: runtimes(),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('bypassPermissions');
  });

  it('resolves nothing when the caller passes no declared modes — the unattended path', () => {
    // THE interactive-only boundary, in the shape it actually holds: a room
    // turn and a relay binding resolve their defaults without handing over a
    // profile, so the stop cannot reach them however it is configured. A
    // scheduled task DOES take the operator's level now (spec
    // `full-power-defaults`, D6) — and it takes it by calling
    // `resolveUnattendedDefaultStop` by name, which is the point of that being
    // a separate export rather than a flag on this one. This function's silence
    // for a caller with no profile is unchanged.
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toEqual({});
  });

  it("maps the agent's own stop, over the server's, to a permission mode", () => {
    const resolved = resolveForRuntime({
      runtimeType: 'claude-code',
      runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      agent: { filesAndCommands: 'act' },
      permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
    });
    expect(resolved.permissionMode).toBe('acceptEdits');
  });
});

describe('resolveUnattendedDefaultStop', () => {
  it("lets the agent's own stop beat the runtime's and the global one", () => {
    const config = runtimes({
      defaultTrustStop: 'autonomy',
      codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'act' },
    });
    expect(
      resolveUnattendedDefaultStop({
        configSection: 'codex',
        runtimes: config,
        agent: { filesAndCommands: 'ask' },
      })
    ).toBe('ask');
    // An agent with no stop of its own keeps the runtime's answer.
    expect(
      resolveUnattendedDefaultStop({ configSection: 'codex', runtimes: config, agent: {} })
    ).toBe('act');
  });

  it('lets the runtime that declared a section override the global stop', () => {
    const config = runtimes({
      defaultTrustStop: 'autonomy',
      codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'ask' },
    });

    expect(resolveUnattendedDefaultStop({ configSection: 'codex', runtimes: config })).toBe('ask');
    // And every runtime that did not override it stays on the global answer.
    expect(resolveUnattendedDefaultStop({ configSection: 'claudeCode', runtimes: config })).toBe(
      'autonomy'
    );
  });

  it('reads a per-runtime null as "no answer here", not as "no answer at all"', () => {
    expect(
      resolveUnattendedDefaultStop({
        configSection: 'claudeCode',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
      })
    ).toBe('act');
  });

  it('answers autonomy on a fresh install (ADR 261006-225605)', () => {
    expect(
      resolveUnattendedDefaultStop({ configSection: 'claudeCode', runtimes: runtimes() })
    ).toBe('autonomy');
  });
});

/**
 * The stop, as the runtime's own mode id — the one call a surface nobody is
 * watching makes when it follows the operator's power level (DOR-1917).
 *
 * The two callers are a scheduled run and a room turn, and the thing that must
 * stay true across them is that the same stop lands on the same mode the DIAL
 * would show as selected. Driven against the REAL shipped capability profiles
 * rather than a fixture, because that is the claim: a second copy of the mapping
 * is how a default and the dial came to disagree in the first place.
 */
describe('resolveUnattendedPermissionMode', () => {
  it("answers the runtime's own id for the configured stop", () => {
    expect(
      resolveUnattendedPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toBe('bypassPermissions');
  });

  it('takes the FIRST mode a runtime declares at a stop, exactly as the dial does', () => {
    // Claude Code declares `acceptEdits` and `auto` at `act`, in that order.
    // Which one the middle stop means is the runtime's declared order to decide,
    // and this is the assertion that would notice the two answers drifting.
    expect(
      resolveUnattendedPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({ defaultTrustStop: 'act' }),
      })
    ).toBe('acceptEdits');
  });

  it('resolves one shared stop against each runtime\u2019s OWN declaration', () => {
    // One setting, answered per runtime through that runtime's profile. The
    // three shipped adapters happen to have converged on the same id at this
    // stop, so asserting "three different ids" would be asserting a coincidence
    // — what has to hold is that each answer is a mode that runtime actually
    // declares AT the configured stop, which is what makes the setting portable
    // when an adapter names its own differently.
    const config = runtimes({ defaultTrustStop: 'autonomy' });

    for (const capabilities of [
      CLAUDE_CODE_CAPABILITIES,
      CODEX_CAPABILITIES,
      OPENCODE_CAPABILITIES,
    ]) {
      const mode = resolveUnattendedPermissionMode({ capabilities, runtimes: config });
      expect(
        capabilities.permissionModes.values.find((declared) => declared.id === mode)?.stop
      ).toBe('autonomy');
    }
  });

  it('lets a per-runtime override beat the global stop', () => {
    expect(
      resolveUnattendedPermissionMode({
        capabilities: CLAUDE_CODE_CAPABILITIES,
        runtimes: runtimes({
          defaultTrustStop: 'autonomy',
          claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultTrustStop: 'ask' },
        }),
      })
    ).toBe('default');
  });
});
