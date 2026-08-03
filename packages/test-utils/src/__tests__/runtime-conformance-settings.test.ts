/**
 * Proof that the conformance suite's settings gate can FAIL.
 *
 * The suite itself only ever runs against adapters that are supposed to pass,
 * so a green conformance run is no evidence the settings assertions fired at
 * all. These tests drive the same predicate the suite calls
 * ({@link validateSettingsCapability}) with deliberately-malformed
 * declarations and assert each one is rejected.
 *
 * They go through `FakeAgentRuntime`'s real read path — construct with the bad
 * value, then validate what `getCapabilities().settings` reports — because
 * that is the path the suite uses. Nothing here re-implements the rules.
 */
import { describe, expect, it } from 'vitest';
import type { RuntimeSettingsCapability } from '@dorkos/shared/agent-runtime';
import { DEFAULT_FAKE_SETTINGS, FakeAgentRuntime } from '../fake-agent-runtime.js';
import { validateSettingsCapability } from '../runtime-conformance.js';

/**
 * The declaration a runtime built with `settings` reports, read back the way
 * the conformance suite reads it.
 *
 * @param settings - Declaration to hand the fake, malformed values included.
 * @returns Whatever `getCapabilities().settings` reports.
 */
function declared(settings: unknown): unknown {
  const runtime = new FakeAgentRuntime('fake', {
    settings: settings as RuntimeSettingsCapability,
  });
  return runtime.getCapabilities().settings;
}

describe('validateSettingsCapability', () => {
  it('accepts the fake default declaration', () => {
    expect(validateSettingsCapability(DEFAULT_FAKE_SETTINGS)).toEqual([]);
  });

  it('accepts a full declaration with a config section and distinct sections', () => {
    expect(
      validateSettingsCapability(
        declared({
          configSection: 'claudeCode',
          supportsEffort: true,
          sections: [{ kind: 'claude-accounts' }, { kind: 'claude-model' }],
        })
      )
    ).toEqual([]);
  });

  it('rejects a capability whose settings are omitted entirely', () => {
    // The shape a runtime written before the field existed reports — the exact
    // drift the compile-time type cannot catch once a cast is involved.
    const capabilities = new FakeAgentRuntime().getCapabilities() as unknown as Record<
      string,
      unknown
    >;
    delete capabilities.settings;

    const failures = validateSettingsCapability(capabilities.settings);
    expect(failures).toEqual(['capabilities.settings is required']);
  });

  it('rejects an empty configSection', () => {
    const failures = validateSettingsCapability(
      declared({ configSection: '', supportsEffort: false, sections: [] })
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('settings.configSection');
  });

  it('rejects a whitespace-only configSection', () => {
    const failures = validateSettingsCapability(
      declared({ configSection: '   ', supportsEffort: false, sections: [] })
    );
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('settings.configSection');
  });

  it('rejects a section with an empty kind', () => {
    const failures = validateSettingsCapability(
      declared({ configSection: null, supportsEffort: false, sections: [{ kind: '' }] })
    );
    expect(failures).toEqual(['settings.sections[0].kind must be a non-empty string']);
  });

  it('rejects duplicate section kinds, naming the duplicate', () => {
    const failures = validateSettingsCapability(
      declared({
        configSection: null,
        supportsEffort: false,
        sections: [{ kind: 'claude-accounts' }, { kind: 'claude-accounts' }],
      })
    );
    expect(failures).toEqual([
      "settings.sections declares the kind 'claude-accounts' more than once",
    ]);
  });

  it('rejects a non-boolean supportsEffort and a non-array sections', () => {
    const failures = validateSettingsCapability(
      declared({ configSection: null, supportsEffort: 'yes', sections: null })
    );
    expect(failures).toEqual([
      'settings.supportsEffort must be a boolean',
      'settings.sections must be an array',
    ]);
  });

  it('reports every violation at once rather than stopping at the first', () => {
    const failures = validateSettingsCapability(
      declared({
        configSection: '',
        supportsEffort: undefined,
        sections: [{ kind: 'a' }, { kind: 'a' }, null],
      })
    );
    expect(failures).toHaveLength(4);
  });
});
