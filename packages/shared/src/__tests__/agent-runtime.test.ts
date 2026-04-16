/**
 * Type-shape tests for the evolved `RuntimeCapabilities` contract.
 *
 * These tests are primarily compile-time assertions: if the shared type shape
 * regresses, the TypeScript compiler will fail them. A few runtime checks are
 * included to pin the minimum/maximum acceptable variance for consumers.
 *
 * @module shared/__tests__/agent-runtime
 */
import { describe, it, expect } from 'vitest';
import type { RuntimeCapabilities, PermissionModeDescriptor } from '../agent-runtime.js';

describe('RuntimeCapabilities shape', () => {
  it('accepts a Claude-like declaration with four permission-mode descriptors and a features entry', () => {
    const claudeLike: RuntimeCapabilities = {
      supportsResume: true,
      supportsMcp: true,
      supportsCostTracking: true,
      supportsToolApproval: true,
      supportsQuestionPrompt: true,
      supportsPlugins: true,
      permissionModes: {
        supported: true,
        values: [
          { id: 'default', label: 'Default' },
          { id: 'acceptEdits', label: 'Accept edits' },
          { id: 'plan', label: 'Plan' },
          { id: 'bypassPermissions', label: 'Bypass permissions' },
        ],
      },
      features: {
        claudeSkills: { enabled: true },
      },
    };

    expect(claudeLike.permissionModes.supported).toBe(true);
    expect(claudeLike.permissionModes.values).toHaveLength(4);
    expect(claudeLike.features.claudeSkills).toEqual({ enabled: true });
  });

  it('accepts a runtime that declares no permission-mode support via { supported: false, values: [] }', () => {
    const minimal: RuntimeCapabilities = {
      supportsResume: false,
      supportsMcp: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      permissionModes: { supported: false, values: [] },
      features: {},
    };

    expect(minimal.permissionModes.supported).toBe(false);
    expect(minimal.permissionModes.values).toEqual([]);
  });

  it('treats features as Record<string, unknown> — heterogeneous values are allowed', () => {
    const caps: RuntimeCapabilities = {
      supportsResume: true,
      supportsMcp: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      permissionModes: { supported: false, values: [] },
      features: {
        aString: 'hello',
        aNumber: 42,
        aBoolean: true,
        anObject: { nested: [1, 2, 3] },
        aNull: null,
      },
    };

    expect(caps.features.aString).toBe('hello');
    expect(caps.features.aNumber).toBe(42);
    expect(caps.features.anObject).toEqual({ nested: [1, 2, 3] });
  });

  it('allows PermissionModeDescriptor with only required id and label', () => {
    const minimal: PermissionModeDescriptor = {
      id: 'default',
      label: 'Default',
    };

    expect(minimal.id).toBe('default');
    expect(minimal.label).toBe('Default');
    expect(minimal.description).toBeUndefined();
  });

  it('allows PermissionModeDescriptor with an optional description', () => {
    const described: PermissionModeDescriptor = {
      id: 'plan',
      label: 'Plan',
      description: 'Research only, no edits',
    };

    expect(described.description).toBe('Research only, no edits');
  });
});
