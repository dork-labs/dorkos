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
import type { RuntimeCapabilities, RuntimeSettingsCapability } from '@dorkos/shared/agent-runtime';
import { USER_CONFIG_DEFAULTS, type UserConfig } from '@dorkos/shared/config-schema';
import { writeManifest } from '@dorkos/shared/manifest';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';
import type { SessionSettings } from '@dorkos/shared/types';
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
  resolveUnattendedDefaultStop,
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
  mcpServers: [],
};

/** The stored `runtimes` block, with one section's fields replaced. */
function runtimes(overrides: Partial<UserConfig['runtimes']> = {}): UserConfig['runtimes'] {
  return { ...USER_CONFIG_DEFAULTS.runtimes, ...overrides };
}

/**
 * Every shipped runtime's own capability profile, keyed by type — the map the
 * server hands `describeExecutionDefaults`, built the way
 * `runtimeRegistry.getAllCapabilities()` builds it. `test-mode` belongs in it:
 * a registered runtime that declares no config section is the case the report
 * has to leave out, and it can only be left out if it was offered.
 */
const REGISTERED_CAPABILITIES: Record<string, RuntimeCapabilities> = {
  'claude-code': CLAUDE_CODE_CAPABILITIES,
  codex: CODEX_CAPABILITIES,
  opencode: OPENCODE_CAPABILITIES,
  'test-mode': TEST_MODE_CAPABILITIES,
};

/**
 * A capability map from settings declarations alone, for the cases no shipped
 * adapter declares — an unknown section, or a runtime whose declared effort
 * support disagrees with the config shape it points at.
 *
 * @param declarations - Settings declaration per runtime type
 */
function declaring(
  declarations: Record<string, RuntimeSettingsCapability>
): Record<string, RuntimeCapabilities> {
  return Object.fromEntries(
    Object.entries(declarations).map(([type, settings]) => [
      type,
      { ...TEST_MODE_CAPABILITIES, type, settings },
    ])
  );
}

/**
 * Resolve defaults the way the server does, with the runtime's own DECLARATIONS
 * travelling alongside its type.
 *
 * Which config section holds a runtime's defaults, and whether it takes an
 * effort at all, are that runtime's declarations now rather than lookups this
 * module keeps — so a test names a runtime and gets what that runtime really
 * declares, the same values `RuntimeRegistry` reads off it. Pass either field
 * explicitly to override it; their own rules are pinned in their own describe
 * blocks below.
 *
 * @param opts - Exactly {@link resolveSessionDefaults}'s options
 */
function resolveForRuntime(opts: Parameters<typeof resolveSessionDefaults>[0]): SessionSettings {
  const declared = REGISTERED_CAPABILITIES[opts.runtimeType]?.settings;
  return resolveSessionDefaults({
    configSection: declared?.configSection ?? null,
    supportsEffort: declared?.supportsEffort,
    ...opts,
  });
}

describe('resolveSessionDefaults', () => {
  it('resolves nothing on a fresh install, so the runtime keeps choosing', () => {
    // The shipped default is `null` everywhere: byte for byte the behavior
    // before any of these fields existed.
    expect(resolveForRuntime({ runtimeType: 'claude-code', runtimes: runtimes() })).toEqual({});
    expect(resolveForRuntime({ runtimeType: 'codex', runtimes: runtimes() })).toEqual({});
    expect(resolveForRuntime({ runtimeType: 'opencode', runtimes: runtimes() })).toEqual({});
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

    expect(resolveForRuntime({ runtimeType: 'claude-code', runtimes: config })).toEqual({
      model: 'opus',
      effort: 'high',
    });
    // Per runtime, and this is why: `opus` would be meaningless to Codex, and
    // Codex's own id meaningless to Claude Code. One shared default would be
    // wrong for at least one of them the moment anybody set it.
    expect(resolveForRuntime({ runtimeType: 'codex', runtimes: config })).toEqual({
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

    expect(resolveForRuntime({ runtimeType: 'opencode', runtimes: config })).toEqual({
      model: 'openrouter/anthropic/claude-opus-4.6',
    });
  });

  it('resolves each field on its own', () => {
    const config = runtimes({
      claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultEffort: 'max' },
    });
    expect(resolveForRuntime({ runtimeType: 'claude-code', runtimes: config })).toEqual({
      effort: 'max',
    });
  });

  it('resolves nothing when no config manager exists yet', () => {
    // No mocks in this file, and nothing here calls `initConfigManager` — so
    // the singleton really is undefined, exactly as it is for any caller that
    // reaches the registry before the server has read its config. Seeding is a
    // preference; a session must still be able to start without one.
    expect(resolveForRuntime({ runtimeType: 'claude-code' })).toEqual({});
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

  it('answers nothing for a runtime that declares no config section', () => {
    // `test-mode` is a real registered runtime with no settings of its own — it
    // declares `configSection: null`. No server default; never an error.
    expect(resolveForRuntime({ runtimeType: 'test-mode', runtimes: runtimes() })).toEqual({});
  });
});

describe('resolveSessionDefaults — the declared effort support', () => {
  // Whether a runtime takes an effort at all is that runtime's declaration,
  // handed over by the caller. Nothing here keeps a list of which runtimes have
  // one, so these are the rules that replace it.
  it("drops an agent's effort on a runtime that declares it has none", () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'some-runtime',
        agent: { effort: 'high' },
        supportsEffort: false,
        runtimes: runtimes(),
      })
    ).toEqual({});
  });

  it("keeps an agent's effort on a runtime that declares it has one", () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'some-runtime',
        agent: { effort: 'high' },
        supportsEffort: true,
        runtimes: runtimes(),
      })
    ).toEqual({ effort: 'high' });
  });

  it('keeps it when the caller says nothing — unknown is never a mute', () => {
    // The permissive default, stated out loud because it is a decision and not
    // an accident: a runtime nobody has wired this through yet still honors an
    // agent's effort, rather than silently dropping it with nothing on screen
    // to say why. The mute belongs to runtimes that SAID they have none.
    expect(
      resolveSessionDefaults({
        runtimeType: 'a-runtime-nobody-wired-up',
        agent: { effort: 'high' },
        runtimes: runtimes(),
      })
    ).toEqual({ effort: 'high' });
  });

  it('leaves the model alone either way — only the effort is gated', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'some-runtime',
        agent: { model: 'a-model', effort: 'high' },
        supportsEffort: false,
        runtimes: runtimes(),
      })
    ).toEqual({ model: 'a-model' });
  });
});

describe('resolveSessionDefaults — the declared config section', () => {
  // The section a runtime's defaults live under is that runtime's own
  // declaration, handed over by the caller. Nothing here keeps a second list of
  // which runtime maps to which config key, so these are the rules that replace
  // it.
  const withEverythingSet = runtimes({
    claudeCode: {
      ...USER_CONFIG_DEFAULTS.runtimes.claudeCode,
      defaultModel: 'opus',
      defaultEffort: 'high',
    },
    codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultModel: 'gpt-5.3-codex' },
  });

  it('reads the section the caller declares, not one derived from the type', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'a-runtime-by-any-name',
        configSection: 'codex',
        runtimes: withEverythingSet,
      })
    ).toEqual({ model: 'gpt-5.3-codex' });
  });

  it('answers nothing per-runtime when the section is omitted', () => {
    // Omitted is a real answer — "this runtime has no section of its own" — and
    // it is the same answer `test-mode` gets. It is also what an unregistered
    // runtime gets on a degraded build, where seeding another runtime's model
    // id would be worse than seeding nothing.
    expect(
      resolveSessionDefaults({ runtimeType: 'claude-code', runtimes: withEverythingSet })
    ).toEqual({});
  });

  it('answers nothing per-runtime for a section this build has no key for', () => {
    expect(
      resolveSessionDefaults({
        runtimeType: 'from-the-future',
        configSection: 'notARealSection',
        runtimes: withEverythingSet,
      })
    ).toEqual({});
  });

  it('still applies the GLOBAL trust stop to a runtime with no section', () => {
    // The global stop is runtime-neutral by construction, so "every new session
    // asks first" has to mean every runtime — not every runtime somebody wrote
    // a settings section for.
    expect(
      resolveSessionDefaults({
        runtimeType: 'test-mode',
        configSection: null,
        runtimes: runtimes({ defaultTrustStop: 'ask' }),
        permissionModes: TEST_MODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'always-deny' });
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
      resolveForRuntime({
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
      resolveForRuntime({
        runtimeType: 'claude-code',
        agent: { effort: 'max' },
        runtimes: config,
      })
    ).toEqual({ model: 'opus', effort: 'max' });
  });

  it("answers with the agent's values when the server has none", () => {
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        agent: { model: 'sonnet' },
        runtimes: runtimes(),
      })
    ).toEqual({ model: 'sonnet' });
  });

  it('honors an agent on a runtime with no config section of its own', () => {
    expect(
      resolveForRuntime({
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
      resolveForRuntime({
        runtimeType: 'opencode',
        agent: { effort: 'high' },
        runtimes: runtimes(),
      })
    ).toEqual({});
  });

  it("keeps that agent's model on OpenCode — only the effort is unsupported", () => {
    expect(
      resolveForRuntime({
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
      resolveForRuntime({
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
      resolveForRuntime({
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
      resolveForRuntime({
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
      resolveForRuntime({
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
    expect(resolveForRuntime({ runtimeType: 'codex', agent: {}, runtimes: config })).toEqual({
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
  it('reports one entry per runtime that declares a config section', () => {
    const view = describeExecutionDefaults(REGISTERED_CAPABILITIES, runtimes());
    expect(view.runtime).toBe('claude-code');
    expect(view.perRuntime.map((entry) => entry.runtime)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
  });

  it('leaves out a registered runtime that declares no config section', () => {
    // `test-mode` is a real registered runtime whose declaration says
    // `configSection: null`. Absence in the report is how that reaches the
    // screen — it has no server default and never will.
    const view = describeExecutionDefaults(REGISTERED_CAPABILITIES, runtimes());
    expect(view.perRuntime.map((entry) => entry.runtime)).not.toContain('test-mode');
  });

  it('leaves out a runtime that is not registered at all, and reports the rest unchanged', () => {
    // A runtime turned off (`runtimes.codex.enabled: false`) never registers,
    // so it is not in the capability map and not in this report. Its stored
    // defaults are untouched by that: they stay in config and apply again the
    // moment it comes back. The report covers each REGISTERED runtime, and the
    // other rows must not notice the gap.
    const view = describeExecutionDefaults(
      declaring({
        'claude-code': CLAUDE_CODE_CAPABILITIES.settings,
        opencode: OPENCODE_CAPABILITIES.settings,
      }),
      runtimes({
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
        codex: { ...USER_CONFIG_DEFAULTS.runtimes.codex, defaultTrustStop: 'ask' },
      })
    );

    expect(view.perRuntime.map((entry) => entry.runtime)).toEqual(['claude-code', 'opencode']);
    expect(view.perRuntime.find((e) => e.runtime === 'claude-code')).toEqual({
      runtime: 'claude-code',
      model: 'opus',
      effort: null,
      trustStop: null,
      supportsEffort: true,
    });
    expect(view.perRuntime.find((e) => e.runtime === 'opencode')).toEqual({
      runtime: 'opencode',
      model: null,
      effort: null,
      trustStop: null,
      supportsEffort: false,
    });
  });

  it('reads exactly the section the runtime declares, and no other', () => {
    // The runtime type and the config key are not the same string and never
    // were. What ties them now is the runtime's own declaration, so a runtime
    // called anything at all reads the section it named.
    const view = describeExecutionDefaults(
      declaring({ 'codex-under-another-name': CODEX_CAPABILITIES.settings }),
      runtimes({
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultModel: 'opus' },
        codex: {
          ...USER_CONFIG_DEFAULTS.runtimes.codex,
          defaultModel: 'gpt-5.3-codex',
          defaultEffort: 'low',
          defaultTrustStop: 'ask',
        },
      })
    );
    expect(view.perRuntime).toEqual([
      {
        runtime: 'codex-under-another-name',
        model: 'gpt-5.3-codex',
        effort: 'low',
        trustStop: 'ask',
        supportsEffort: true,
      },
    ]);
  });

  it('skips a section this build has no key for, without throwing', () => {
    // The declaration is `string | null` in shared because the config schema is
    // host-side. A runtime from a newer build naming a section this one has
    // never heard of is dropped — never a crash on the settings screen.
    const view = describeExecutionDefaults(
      declaring({
        'from-the-future': { configSection: 'notARealSection', supportsEffort: true, sections: [] },
        codex: CODEX_CAPABILITIES.settings,
      }),
      runtimes()
    );
    expect(view.perRuntime.map((entry) => entry.runtime)).toEqual(['codex']);
  });

  it('takes supportsEffort from the declaration, not from the config shape', () => {
    // The two can disagree, and the runtime wins: a runtime whose API has no
    // effort reports none even when the section it points at holds one. A
    // reported effort is a control the person can move, so it has to be a
    // control that does something.
    const view = describeExecutionDefaults(
      declaring({
        'effortless-runtime': { configSection: 'claudeCode', supportsEffort: false, sections: [] },
      }),
      runtimes({
        claudeCode: { ...USER_CONFIG_DEFAULTS.runtimes.claudeCode, defaultEffort: 'high' },
      })
    );
    expect(view.perRuntime).toEqual([
      {
        runtime: 'effortless-runtime',
        model: null,
        effort: null,
        trustStop: null,
        supportsEffort: false,
      },
    ]);
  });

  it('orders the report by runtime type id, whatever order the registry holds', () => {
    // Registration order is a startup detail nobody chose. A list that
    // reshuffles between two reads moves the row under the person's cursor.
    const view = describeExecutionDefaults(
      declaring({
        opencode: OPENCODE_CAPABILITIES.settings,
        'claude-code': CLAUDE_CODE_CAPABILITIES.settings,
        codex: CODEX_CAPABILITIES.settings,
      }),
      runtimes()
    );
    expect(view.perRuntime.map((entry) => entry.runtime)).toEqual([
      'claude-code',
      'codex',
      'opencode',
    ]);
  });

  it('reports what is stored, per runtime, in that runtime’s own id space', () => {
    const view = describeExecutionDefaults(
      REGISTERED_CAPABILITIES,
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
    const opencode = describeExecutionDefaults(REGISTERED_CAPABILITIES, runtimes()).perRuntime.find(
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
    const view = describeExecutionDefaults(REGISTERED_CAPABILITIES, runtimes({ default: 'codex' }));
    expect(view.runtime).toBe('codex');
  });

  it('reports the global trust stop and each override, unresolved', () => {
    // Unresolved on purpose: which MODE a stop lands on is the runtime's
    // capability profile's answer, and the cockpit holds those profiles. A
    // resolved id here would be a second copy of that translation for the screen
    // to disagree with.
    const view = describeExecutionDefaults(
      REGISTERED_CAPABILITIES,
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

  it('picks the first-declared mode where a runtime has two at one stop', () => {
    // Claude Code declares `acceptEdits` before `auto`, both at 'act'. The dial
    // resolves the position to the first and offers the second as a switch
    // inside it, and a default has to land on the same one or Settings would
    // promise a stop the session does not show as selected.
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('acceptEdits');
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

  it('resolves the autonomy stop to each runtime’s own word for it', () => {
    const config = runtimes({ defaultTrustStop: 'autonomy' });
    expect(
      resolveForRuntime({
        runtimeType: 'opencode',
        runtimes: config,
        permissionModes: OPENCODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ permissionMode: 'bypassPermissions' });
    expect(
      resolveForRuntime({
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

  it('reads a per-runtime null as "no answer here", not as "no answer at all"', () => {
    expect(
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      }).permissionMode
    ).toBe('acceptEdits');
  });

  it('resolves nothing on a fresh install, so each runtime keeps its own default', () => {
    expect(
      resolveForRuntime({
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
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: runtimes({ defaultTrustStop: 'act' }),
        permissionModes: noMiddleGround,
      })
    ).toEqual({});
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
      resolveForRuntime({
        runtimeType: 'claude-code',
        runtimes: config,
        permissionModes: CLAUDE_CODE_CAPABILITIES.permissionModes.values,
      })
    ).toEqual({ model: 'opus', effort: 'high', permissionMode: 'acceptEdits' });
  });
});

describe('resolveUnattendedDefaultStop', () => {
  it('answers the global stop when that is all there is', () => {
    expect(resolveUnattendedDefaultStop({ runtimes: runtimes({ defaultTrustStop: 'act' }) })).toBe(
      'act'
    );
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

  it('still reads the global stop for a runtime with no config section of its own', () => {
    // `test-mode` declares `configSection: null`, and the stop is runtime-neutral
    // by construction — "every unattended run at my level" has to mean every
    // runtime, not every runtime somebody wrote a settings section for.
    expect(
      resolveUnattendedDefaultStop({
        configSection: null,
        runtimes: runtimes({ defaultTrustStop: 'autonomy' }),
      })
    ).toBe('autonomy');
  });

  it('skips a section this build has no config key for rather than throwing', () => {
    expect(
      resolveUnattendedDefaultStop({
        configSection: 'someRuntimeFromTheFuture',
        runtimes: runtimes({ defaultTrustStop: 'ask' }),
      })
    ).toBe('ask');
  });

  it('answers null on a fresh install, with neither tier set', () => {
    expect(resolveUnattendedDefaultStop({ runtimes: runtimes() })).toBeNull();
    expect(
      resolveUnattendedDefaultStop({ configSection: 'claudeCode', runtimes: runtimes() })
    ).toBe(null);
  });

  it('answers null before the config manager has booted', () => {
    // `configManager` is a `let` that is undefined until `initConfigManager`
    // runs, and no test here initialises it. A missing setting is a reason to
    // fall through, never a reason to refuse the work.
    expect(resolveUnattendedDefaultStop()).toBeNull();
    expect(resolveUnattendedDefaultStop({ configSection: 'claudeCode' })).toBeNull();
  });
});
