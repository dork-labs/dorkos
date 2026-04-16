/**
 * Snapshot-style tests that lock the shape of `CLAUDE_CODE_CAPABILITIES`.
 *
 * The client depends on the exact ids in `permissionModes.values` to render
 * the picker, and on the `features.*` flags to gate Claude-specific UI cues.
 * Any drift here would silently break the UI without a lint/type error, so
 * these tests exist to make drift visible at CI time.
 *
 * @see ../runtime-constants.ts
 */
import { describe, it, expect } from 'vitest';
import { CLAUDE_CODE_CAPABILITIES } from '../runtime-constants.js';

describe('CLAUDE_CODE_CAPABILITIES', () => {
  it('exposes all four Claude SDK permission modes', () => {
    expect(CLAUDE_CODE_CAPABILITIES.permissionModes.supported).toBe(true);
    expect(CLAUDE_CODE_CAPABILITIES.permissionModes.values).toHaveLength(4);
    expect(CLAUDE_CODE_CAPABILITIES.permissionModes.values.map((v) => v.id)).toEqual([
      'default',
      'acceptEdits',
      'plan',
      'bypassPermissions',
    ]);
  });

  it('provides id, label, and description for each permission mode descriptor', () => {
    for (const descriptor of CLAUDE_CODE_CAPABILITIES.permissionModes.values) {
      expect(descriptor.id).toBeTypeOf('string');
      expect(descriptor.id.length).toBeGreaterThan(0);
      expect(descriptor.label).toBeTypeOf('string');
      expect(descriptor.label.length).toBeGreaterThan(0);
      expect(descriptor.description).toBeTypeOf('string');
      expect(descriptor.description!.length).toBeGreaterThan(0);
    }
  });

  it('declares Claude-specific UI feature flags consumers will gate on', () => {
    expect(CLAUDE_CODE_CAPABILITIES.features.claudeSkills).toBe(true);
    expect(CLAUDE_CODE_CAPABILITIES.features.claudeHooks).toBe(true);
    expect(CLAUDE_CODE_CAPABILITIES.features.claudeSlashCommands).toBe(true);
  });

  it('reports plugin support for the Claude-specific transport shaping', () => {
    expect(CLAUDE_CODE_CAPABILITIES.supportsPlugins).toBe(true);
  });
});
