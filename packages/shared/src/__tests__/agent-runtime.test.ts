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
import type {
  RuntimeCapabilities,
  PermissionModeDescriptor,
  DependencyCheck,
} from '../agent-runtime.js';
import { deriveRuntimeReadiness } from '../agent-runtime.js';

/** Build a satisfied CLI-binary check for a runtime under test. */
function cli(name: string): DependencyCheck {
  return { name, description: 'CLI', status: 'satisfied', version: '1.0.0' };
}

/** Build an auth check with the given status; the name matches the `/auth|login/i` contract. */
function auth(name: string, status: DependencyCheck['status']): DependencyCheck {
  return { name, description: 'auth', status };
}

describe('RuntimeCapabilities shape', () => {
  it('accepts a Claude-like declaration with four permission-mode descriptors and a features entry', () => {
    const claudeLike: RuntimeCapabilities = {
      supportsResume: true,
      supportsMcp: true,
      supportsCostTracking: true,
      supportsToolApproval: true,
      supportsQuestionPrompt: true,
      supportsPlugins: true,
      nativeContext: [],
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
      nativeContext: [],
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

describe('deriveRuntimeReadiness', () => {
  it('legacy shape: a binary-only claude-code (no auth check) still reads ready', () => {
    // Backward-compat: a runtime that declares no auth check is treated as
    // "auth not required" so old single-dependency shapes never regress.
    const readiness = deriveRuntimeReadiness('claude-code', [cli('Claude Code CLI')]);
    expect(readiness).toEqual({ state: 'ready' });
  });

  it('binary + satisfied auth: claude-code reads ready', () => {
    const readiness = deriveRuntimeReadiness('claude-code', [
      cli('Claude Code CLI'),
      auth('Claude Code authentication', 'satisfied'),
    ]);
    expect(readiness).toEqual({ state: 'ready' });
  });

  it('binary present + auth missing: claude-code projects to Connect with kind "login"', () => {
    const readiness = deriveRuntimeReadiness('claude-code', [
      cli('Claude Code CLI'),
      auth('Claude Code authentication', 'missing'),
    ]);
    expect(readiness.state).toBe('connect');
    expect(readiness.connect?.kind).toBe('login');
    expect(readiness.connect?.label).toMatch(/claude/i);
  });

  it('binary missing: claude-code projects to Connect with kind "install" regardless of auth', () => {
    const readiness = deriveRuntimeReadiness('claude-code', [
      { name: 'Claude Code CLI', description: 'CLI', status: 'missing' },
      auth('Claude Code authentication', 'missing'),
    ]);
    expect(readiness.state).toBe('connect');
    expect(readiness.connect?.kind).toBe('install');
  });

  it('opencode with binary present + auth missing maps to the provider-picker, not login', () => {
    const readiness = deriveRuntimeReadiness('opencode', [
      cli('OpenCode CLI'),
      auth('OpenCode authentication', 'missing'),
    ]);
    expect(readiness.state).toBe('connect');
    expect(readiness.connect?.kind).toBe('provider-picker');
  });
});
