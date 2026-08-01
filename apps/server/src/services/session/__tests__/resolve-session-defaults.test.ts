/**
 * The inheritance ladder for a new session's model, effort and trust stop.
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
import { CLAUDE_CODE_CAPABILITIES } from '../../runtimes/claude-code/runtime-constants.js';
import { CODEX_CAPABILITIES } from '../../runtimes/codex/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../runtimes/opencode/runtime-constants.js';
import { TEST_MODE_CAPABILITIES } from '../../runtimes/test-mode/runtime-constants.js';
import {
  resolveSessionDefaults,
  readAgentExecutionDefaults,
  describeExecutionDefaults,
} from '../resolve-session-defaults.js';

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

describe('describeExecutionDefaults', () => {
  it('reports one entry per runtime that has a config section', () => {
    const view = describeExecutionDefaults(runtimes());
    expect(view.runtime).toBe('claude-code');
    expect(view.perRuntime.map((entry) => entry.runtime)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
  });

  it('reports what is stored, per runtime, in that runtime’s own id space', () => {
    const view = describeExecutionDefaults(
      runtimes({
        claudeCode: {
          ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
          defaultModel: 'opus',
          defaultEffort: 'high',
        },
        codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultModel: 'gpt-5.3-codex' },
      })
    );
    expect(view.perRuntime.find((e) => e.runtime === 'claude-code')).toEqual({
      runtime: 'claude-code',
      model: 'opus',
      effort: 'high',
      supportsEffort: true,
      trustStop: null,
    });
    expect(view.perRuntime.find((e) => e.runtime === 'codex')?.model).toBe('gpt-5.3-codex');
  });

  // The absence has to survive the trip to the screen, or "Not supported by
  // OpenCode" is a claim the payload quietly contradicts.
  it('reports OpenCode as having no effort at all, never a null it could set', () => {
    const opencode = describeExecutionDefaults(runtimes()).perRuntime.find(
      (e) => e.runtime === 'opencode'
    );
    expect(opencode).toEqual({
      runtime: 'opencode',
      model: null,
      effort: null,
      supportsEffort: false,
      trustStop: null,
    });
  });

  it('reports the configured default runtime', () => {
    const view = describeExecutionDefaults(runtimes({ default: 'codex' }));
    expect(view.runtime).toBe('codex');
  });

  it('reports the global trust stop and each override, unresolved', () => {
    // Unresolved on purpose: which MODE a stop lands on is the runtime's
    // capability profile's answer, and the cockpit holds those profiles. A
    // resolved id here would be a second copy of that translation for the screen
    // to disagree with.
    const view = describeExecutionDefaults(
      runtimes({
        defaultTrustStop: 'act',
        codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'ask' },
      })
    );
    expect(view.trustStop).toBe('act');
    expect(view.perRuntime.find((e) => e.runtime === 'codex')?.trustStop).toBe('ask');
    expect(view.perRuntime.find((e) => e.runtime === 'claude-code')?.trustStop).toBeNull();
  });
});

describe('resolveSessionDefaults — the trust stop', () => {
  it('resolves a configured stop into the mode THAT runtime calls it', () => {
    const config = runtimes({ defaultTrustStop: 'act' });
    // Same stop, three different mode ids — which is the entire reason config
    // stores the stop and not the id.
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: config,
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'acceptEdits' });
    expect(
      resolveSessionDefaults({
        runtimeType: 'codex',
        runtimes: config,
        permissionModes: CODEX_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'acceptEdits' });
    expect(
      resolveSessionDefaults({
        runtimeType: 'test-mode',
        runtimes: config,
        permissionModes: TEST_MODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'scripted' });
  });

  it('picks the first-declared mode where a runtime has two at one stop', () => {
    // Claude Code declares `acceptEdits` before `auto`, both at 'act'. The dial
    // resolves the position to the first and offers the second as a switch
    // inside it, and a default has to land on the same one or Settings would
    // promise a stop the session does not show as selected.
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('acceptEdits');
  });

  it('never resolves a way of working — Plan sits at the ask stop but is not it', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'ask' }),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('default');
  });

  it('resolves the autonomy stop to each runtime’s own word for it', () => {
    const config = runtimes({ defaultTrustStop: 'autonomy' });
    expect(
      resolveSessionDefaults({
        runtimeType: 'opencode',
        runtimes: config,
        permissionModes: OPENCODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'bypassPermissions' });
    expect(
      resolveSessionDefaults({
        runtimeType: 'test-mode',
        runtimes: config,
        permissionModes: TEST_MODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'always-allow' });
  });

  it('lets a per-runtime override beat the global stop', () => {
    const config = runtimes({
      defaultTrustStop: 'autonomy',
      codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'ask' },
    });
    expect(
      resolveSessionDefaults({
        runtimeType: 'codex',
        runtimes: config,
        permissionModes: CODEX_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'default' });
    // And leaves every runtime that did not override it on the global answer.
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: config,
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'bypassPermissions' });
  });

  it('reads a per-runtime null as "no answer here", not as "no answer at all"', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('acceptEdits');
  });

  it('resolves nothing on a fresh install, so each runtime keeps its own default', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: runtimes(),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({});
  });

  it('resolves nothing for a runtime that declares no mode at the configured stop', () => {
    // A stop this runtime cannot take is a preference it has no way to honor —
    // not an error, and never rounded off to a neighbouring stop.
    const noMiddleGround = CLAUDE_CODE_CAPABILITIES.permissionModes.values.filter(
      (d) => d.stop !== 'act'
    );
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
        permissionModes: noMiddleGround,
      })
    ).toEqual({});
  });

  it('resolves nothing when the caller passes no declared modes — the unattended path', () => {
    // THE interactive-only boundary, in the shape it actually holds: a room
    // turn, a scheduled task and a relay binding all resolve their defaults
    // without handing over a profile, so the stop cannot reach them however it
    // is configured.
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toEqual({});
  });

  it('resolves alongside model and effort without disturbing either', () => {
    const config = runtimes({
      defaultTrustStop: 'act',
      claudeCode: {
        ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
        defaultModel: 'opus',
        defaultEffort: 'high',
      },
    });
    expect(
      resolveSessionDefaults({
        runtimeType: 'claude-code',
        runtimes: config,
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' });
  });
});
