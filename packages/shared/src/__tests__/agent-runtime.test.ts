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
      type: 'claude-code',
      commandIntents: { compact: { supported: true } },
      supportsResume: true,
      supportsMcp: true,
      supportsManagedMcpServers: true,
      supportsCostTracking: true,
      supportsToolApproval: true,
      supportsQuestionPrompt: true,
      supportsPlugins: true,
      supportsPersistentSession: false,
      supportsSteer: false,
      supportsContextStaging: false,
      mediaOutput: 'none',
      nativeContext: [],
      permissionModes: {
        supported: true,
        values: [
          {
            id: 'default',
            label: 'Default',
            stop: 'ask',
            asks: 'always',
            reach: 'edit',
            promise: 'Asks first.',
          },
          {
            id: 'acceptEdits',
            label: 'Accept edits',
            stop: 'act',
            asks: 'when-risky',
            reach: 'edit',
            promise: 'Edits on its own.',
          },
          {
            id: 'plan',
            label: 'Plan',
            stop: 'ask',
            asks: 'always',
            reach: 'read',
            promise: 'Reads and plans only.',
          },
          {
            id: 'bypassPermissions',
            label: 'Bypass permissions',
            stop: 'autonomy',
            asks: 'never',
            reach: 'everything',
            promise: 'Runs everything without asking.',
          },
        ],
      },
      settings: {
        configSection: 'claudeCode',
        supportsEffort: true,
        sections: [{ kind: 'claude-accounts' }],
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
      type: 'minimal-runtime',
      commandIntents: { compact: { supported: false } },
      supportsResume: false,
      supportsMcp: false,
      supportsManagedMcpServers: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      supportsPersistentSession: false,
      supportsSteer: false,
      supportsContextStaging: false,
      mediaOutput: 'none',
      nativeContext: [],
      permissionModes: { supported: false, values: [] },
      settings: { configSection: null, supportsEffort: false, sections: [] },
      features: {},
    };

    expect(minimal.permissionModes.supported).toBe(false);
    expect(minimal.permissionModes.values).toEqual([]);
  });

  it('treats features as Record<string, unknown> — heterogeneous values are allowed', () => {
    const caps: RuntimeCapabilities = {
      type: 'heterogeneous-runtime',
      commandIntents: { compact: { supported: false } },
      nativeContext: [],
      supportsResume: true,
      supportsMcp: false,
      supportsManagedMcpServers: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      supportsPersistentSession: false,
      supportsSteer: false,
      supportsContextStaging: false,
      mediaOutput: 'none',
      permissionModes: { supported: false, values: [] },
      settings: { configSection: null, supportsEffort: false, sections: [] },
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

  it('requires every runtime to declare its settings surface', () => {
    // Compile-time forcing, the `commandIntents` precedent: a new adapter must
    // not be able to silently omit its settings declaration. If `settings` ever
    // becomes optional this `@ts-expect-error` turns into an unused-directive
    // error — that red is the whole point of the test.
    // @ts-expect-error settings is required
    const withoutSettings: RuntimeCapabilities = {
      type: 'forgetful-runtime',
      commandIntents: { compact: { supported: false } },
      nativeContext: [],
      supportsResume: false,
      supportsMcp: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      supportsPersistentSession: false,
      supportsSteer: false,
      supportsContextStaging: false,
      mediaOutput: 'none',
      permissionModes: { supported: false, values: [] },
      features: {},
    };

    expect(withoutSettings.type).toBe('forgetful-runtime');
  });

  it('requires every runtime to declare all three message-delivery capabilities', () => {
    // Same compile-time forcing, for the flags the dispatcher resolves a
    // disposition against (spec `persistent-session-runtime`). Optional would
    // mean `undefined` — an adapter that never said whether it can steer, read
    // as "cannot" by a falsy check, which is the silent default this repo keeps
    // refusing. If any of the three becomes optional, the `@ts-expect-error`
    // turns into an unused-directive error, and that red is the point.
    // @ts-expect-error supportsPersistentSession / supportsSteer / supportsContextStaging are required
    const undeclared: RuntimeCapabilities = {
      type: 'undeclared-delivery-runtime',
      commandIntents: { compact: { supported: false } },
      nativeContext: [],
      supportsResume: false,
      supportsMcp: false,
      supportsManagedMcpServers: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      permissionModes: { supported: false, values: [] },
      settings: { configSection: null, supportsEffort: false, sections: [] },
      features: {},
    };

    expect(undeclared.type).toBe('undeclared-delivery-runtime');
  });

  it('requires every runtime to declare what it does with media', () => {
    // The same compile-time forcing, for the field that ended a silence: before
    // `mediaOutput` existed, every runtime dropped every image a model or a tool
    // produced and none of them said so, so all three looked identical from the
    // outside and a person paid for a picture that was never shown
    // (ADR 260901-135657). Optional would mean `undefined` — an adapter that
    // never said, read as "no" by a falsy check, which is the same silent
    // default in a new place. If it becomes optional, the `@ts-expect-error`
    // turns into an unused-directive error, and that red is the point.
    // @ts-expect-error mediaOutput is required
    const undeclared: RuntimeCapabilities = {
      type: 'undeclared-media-runtime',
      commandIntents: { compact: { supported: false } },
      nativeContext: [],
      supportsResume: false,
      supportsMcp: false,
      supportsManagedMcpServers: false,
      supportsCostTracking: false,
      supportsToolApproval: false,
      supportsQuestionPrompt: false,
      supportsPlugins: false,
      supportsPersistentSession: false,
      supportsSteer: false,
      supportsContextStaging: false,
      permissionModes: { supported: false, values: [] },
      settings: { configSection: null, supportsEffort: false, sections: [] },
      features: {},
    };

    expect(undeclared.type).toBe('undeclared-media-runtime');
  });

  it('requires a PermissionModeDescriptor to say what its mode does', () => {
    // Identity plus semantics is the whole descriptor: a mode that says what it
    // is called but not what it does is the drift these fields exist to end.
    // `description` and `native` stay optional — both are extra detail, not the
    // meaning anything derives from.
    const minimal: PermissionModeDescriptor = {
      id: 'default',
      label: 'Default',
      stop: 'ask',
      asks: 'always',
      reach: 'edit',
      promise: 'Asks before it edits a file or runs a command.',
    };

    expect(minimal.id).toBe('default');
    expect(minimal.label).toBe('Default');
    expect(minimal.description).toBeUndefined();
    expect(minimal.native).toBeUndefined();
  });

  it('allows PermissionModeDescriptor with an optional description and native name', () => {
    const described: PermissionModeDescriptor = {
      id: 'plan',
      label: 'Plan',
      description: 'Research only, no edits',
      native: 'read-only',
      stop: 'ask',
      asks: 'always',
      reach: 'read',
      promise: 'Reads and plans only. Nothing changes until you approve the plan.',
    };

    expect(described.description).toBe('Research only, no edits');
    expect(described.native).toBe('read-only');
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
