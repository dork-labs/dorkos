/**
 * The inheritance ladder for a new session's model and effort.
 *
 * The config section is passed in rather than mocked: the resolver's whole job is
 * turning a stored `runtimes` block into session settings, and handing it one is
 * the most direct way to ask what it does with each shape.
 */
import { describe, it, expect } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import { createTestDb } from '@dorkos/test-utils/db';
import { RuntimeRegistry } from '../../core/runtime-registry.js';
import { resolveSessionDefaults, readAgentExecutionDefaults } from '../resolve-session-defaults.js';

/** The least manifest that validates, for the on-disk half of the ladder. */
const BASE_MANIFEST: AgentManifest = {
  id: 'agent-defaults-fixture',
  name: 'defaults-fixture',
  description: '',
  runtime: 'claude-code',
  capabilities: [],
  behavior: { responseMode: 'always' },
  registeredAt: new Date().toISOString(),
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

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

describe('resolveSessionDefaults — the agent tier', () => {
  it("prefers the agent's model and effort over the server's", () => {
    const config = runtimes({
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    });
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        agent: { model: 'sonnet', effort: 'low' },
        runtimes: config,
      })
    ).toEqual({ model: 'sonnet', effort: 'low' });
  });

  it('mixes the two tiers per key, not per agent', () => {
    // An agent that only names an effort still starts on the server's model.
    const config = runtimes({
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    });
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        agent: { effort: 'max' },
        runtimes: config,
      })
    ).toEqual({ model: 'opus', effort: 'max' });
  });

  it("answers with the agent's values when the server has none", () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        agent: { model: 'sonnet' },
        runtimes: runtimes(),
      })
    ).toEqual({ model: 'sonnet' });
  });

  it('honors an agent on a runtime with no config section of its own', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'test-mode',
        agent: { model: 'whatever-test-mode-runs' },
        runtimes: runtimes(),
      })
    ).toEqual({ model: 'whatever-test-mode-runs' });
  });

  it('drops an agent effort on OpenCode, which has no effort at its API', () => {
    // The manifest is written once and an agent can be pointed at any runtime,
    // so an agent CAN name an effort and land on OpenCode. Seeding it anyway
    // would put a value on the row that comes back out at the person as a
    // setting doing nothing — the thing "Not supported by OpenCode" denies.
    expect(
      resolveSessionDefaults({
        runtimeType: 'opencode',
        agent: { effort: 'high' },
        runtimes: runtimes(),
      })
    ).toEqual({});
  });

  it("keeps that agent's model on OpenCode — only the effort is unsupported", () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'opencode',
        agent: { model: 'openrouter/anthropic/claude-opus-4.6', effort: 'high' },
        runtimes: runtimes(),
      })
    ).toEqual({ model: 'openrouter/anthropic/claude-opus-4.6' });
  });

  it("drops the agent's model when the session lands on a different runtime", () => {
    // The degraded mode this exists for: `registerOptionalRuntime` tolerates a
    // runtime failing to register (the packaged desktop app bundles only the
    // claude-code SDK), and both runtime resolvers then fall back to the default
    // instead of refusing the turn. Seeding the manifest's model anyway hands
    // the Claude Code SDK a Codex id — an id from another provider's namespace,
    // which no catalog refresh can ever make valid.
    const config = runtimes({
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
    });

    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        agent: { runtime: 'codex', model: 'gpt-5.3-codex' },
        runtimes: config,
      })
    ).toEqual({ model: 'opus' });
  });

  it('seeds it when the session lands on the runtime the manifest names', () => {
    const config = runtimes({
      codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultModel: 'gpt-5.3-codex' },
    });

    expect(
      resolveSessionDefaults({
        runtimeType: 'codex',
        agent: { runtime: 'codex', model: 'gpt-5.4-codex' },
        runtimes: config,
      })
    ).toEqual({ model: 'gpt-5.4-codex' });
  });

  it("keeps the agent's effort across that same mismatch — a rung is not namespaced", () => {
    // The asymmetry is the design's: a model id lives in one runtime's id space
    // (§8), while the effort ladder is one normalized enum every runtime maps
    // into (§4). "Think harder" is the same request wherever it is heard.
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        agent: { runtime: 'codex', model: 'gpt-5.3-codex', effort: 'max' },
        runtimes: runtimes(),
      })
    ).toEqual({ effort: 'max' });
  });

  it('takes a model at face value when the caller names no runtime for it', () => {
    // A shape `readManifest` cannot produce — `runtime` is required there — so
    // it is a claim only a programmatic caller can make, and it is honored.
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        agent: { model: 'sonnet' },
        runtimes: runtimes(),
      })
    ).toEqual({ model: 'sonnet' });
  });

  it('treats an agent with no opinion as no tier at all', () => {
    const config = runtimes({
      codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultModel: 'gpt-5.3-codex' },
    });
    expect(resolveSessionDefaults({ runtimeType: 'codex', agent: {}, runtimes: config })).toEqual({
      model: 'gpt-5.3-codex',
    });
  });
});

describe('readAgentExecutionDefaults', () => {
  it('reads what the manifest names', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-defaults-'));
    await writeManifest(dir, {
      ...BASE_MANIFEST,
      model: 'sonnet',
      effort: 'low',
    });
    expect(await readAgentExecutionDefaults(dir)).toEqual({
      runtime: 'claude-code',
      model: 'sonnet',
      effort: 'low',
    });
  });

  it('reports only the runtime for a manifest that names neither', async () => {
    // The runtime always travels: it is what makes a model id readable, so its
    // presence is not an opinion about model or effort.
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-defaults-'));
    await writeManifest(dir, BASE_MANIFEST);
    expect(await readAgentExecutionDefaults(dir)).toEqual({ runtime: 'claude-code' });
  });

  it('says nothing for a directory with no agent, and never throws', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-defaults-'));
    expect(await readAgentExecutionDefaults(dir)).toEqual({});
    expect(await readAgentExecutionDefaults(path.join(dir, 'not-here'))).toEqual({});
    expect(await readAgentExecutionDefaults(undefined)).toEqual({});
  });
});
