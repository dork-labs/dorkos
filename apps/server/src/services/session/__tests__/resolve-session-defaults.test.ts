/**
 * The inheritance ladder for a new session's model and effort.
 *
 * The config section is passed in rather than mocked: the resolver's whole job is
 * turning a stored `runtimes` block into session settings, and handing it one is
 * the most direct way to ask what it does with each shape.
 */
import { describe, it, expect } from 'vitest';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { createTestDb } from '@dorkos/test-utils/db';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { resolveSessionDefaults } from '../resolve-session-defaults.js';

/** The stored `runtimes` block, with one section's fields replaced. */
function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

describe('resolveSessionDefaults', () => {
  it('resolves nothing on a fresh install, so the runtime keeps choosing', () => {
    // The shipped default is `null` everywhere: byte for byte the behavior
    // before any of these fields existed.
    expect(resolveSessionDefaults({ runtimeType: 'claude-code', runtimes: runtimes() })).toEqual(
      {}
    );
    expect(resolveSessionDefaults({ runtimeType: 'codex', runtimes: runtimes() })).toEqual({});
    expect(resolveSessionDefaults({ runtimeType: 'opencode', runtimes: runtimes() })).toEqual({});
  });

  it("uses the runtime's own configured model and effort", () => {
    const config = runtimes({
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
      codex: {
        ...USER_CONFIG_DEFAULTS.runtimes.codex,
        defaultModel: 'gpt-5.3-codex',
        defaultEffort: 'low',
      },
    });

    expect(resolveSessionDefaults({ runtimeType: 'claude-code', runtimes: config })).toEqual({
      model: 'opus',
      effort: 'high',
    });
    // Per runtime, and this is why: `opus` would be meaningless to Codex, and
    // Codex's own id meaningless to Claude Code. One shared default would be
    // wrong for at least one of them the moment anybody set it.
    expect(resolveSessionDefaults({ runtimeType: 'codex', runtimes: config })).toEqual({
      model: 'gpt-5.3-codex',
      effort: 'low',
    });
  });

  it('gives OpenCode a model and never an effort', () => {
    // OpenCode's prompt API takes no effort at all, so the config section has no
    // such field — the absence IS the honest answer, and the UI says so out loud.
    const config = runtimes({
      opencode: {
        ...USER_CONFIG_DEFAULTS.runtimes.opencode,
        defaultModel: 'openrouter/anthropic/claude-opus-4.6',
      },
    });

    expect(resolveSessionDefaults({ runtimeType: 'opencode', runtimes: config })).toEqual({
      model: 'openrouter/anthropic/claude-opus-4.6',
    });
  });

  it('resolves each field on its own', () => {
    const config = runtimes({
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultEffort: 'max' },
    });
    expect(resolveSessionDefaults({ runtimeType: 'claude-code', runtimes: config })).toEqual({
      effort: 'max',
    });
  });

  it('resolves nothing when no config manager exists yet', () => {
    // No mocks in this file, and nothing here calls `initConfigManager` — so
    // the singleton really is undefined, exactly as it is for any caller that
    // reaches the registry before the server has read its config. Seeding is a
    // preference; a session must still be able to start without one.
    expect(resolveSessionDefaults({ runtimeType: 'claude-code' })).toEqual({});
  });

  it('lets a session be created with no config manager at all', () => {
    // The same claim one layer up, in the shape it would actually bite: the
    // registry consults this on every row it creates.
    const registry = new RuntimeRegistry();
    registry.setDb(createTestDb());
    return expect(registry.persistSessionRuntime('cold-boot-session', 'claude-code')).resolves.toBe(
      true
    );
  });

  it('answers nothing for a runtime with no config section', () => {
    // `test-mode` is a real registered runtime with no settings of its own. A
    // runtime absent from the map has no server default; it is never an error.
    expect(resolveSessionDefaults({ runtimeType: 'test-mode', runtimes: runtimes() })).toEqual({});
  });
});
