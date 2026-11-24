/**
 * The inheritance ladder for a new session's model and effort, what an agent's
 * manifest says, and the per-runtime defaults report the settings screen reads.
 *
 * The config section is passed in rather than mocked: the resolver's whole job is
 * turning a stored `runtimes` block into session settings, and handing it one is
 * the most direct way to ask what it does with each shape.
 */
import { USER_CONFIG_DEFAULTS } from '@dorkos/shared/config-schema';
import { describe, it, expect } from 'vitest';
import { createTestDb } from '@dorkos/test-utils/db';
import { RuntimeRegistry } from '../../../core/runtime-registry.js';
import { TEST_MODE_CAPABILITIES } from '../../../runtimes/test-mode/runtime-constants.js';
import {
  resolveSessionDefaults,
  readAgentExecutionDefaults,
  describeExecutionDefaults,
} from '../../resolution/resolve-session-defaults.js';
import {
  runtimes,
  resolveForRuntime,
  BASE_MANIFEST,
  REGISTERED_CAPABILITIES,
  declaring,
} from './resolve-session-defaults.fixtures.js';
import { DOE_CAPABILITIES } from '../../../runtimes/doe/runtime-constants.js';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeManifest } from '@dorkos/shared/manifest';
import { CLAUDE_CODE_CAPABILITIES } from '../../../runtimes/claude-code/runtime-constants.js';
import { OPENCODE_CAPABILITIES } from '../../../runtimes/opencode/runtime-constants.js';
import {
  initPermissionGate,
  readAgentPermissionsFromManifest,
  resetPermissionGate,
} from '../../../core/capabilities/permission-enforcement.js';

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

  it('lets a session be created with no config manager at all', () => {
    // The same claim one layer up, in the shape it would actually bite: the
    // registry consults this on every row it creates.
    const registry = new RuntimeRegistry();
    registry.setDb(createTestDb());
    return expect(
      registry.persistSessionRuntime('cold-boot-session', 'claude-code', { kind: 'interactive' })
    ).resolves.toBe(true);
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

  it("reads the agent's own Files & commands stop, through the wired gate reader", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-defaults-'));
    await writeManifest(dir, { ...BASE_MANIFEST, permissions: { filesAndCommands: 'ask' } });
    initPermissionGate({ readAgentPermissions: readAgentPermissionsFromManifest });
    try {
      expect(await readAgentExecutionDefaults(dir)).toEqual({
        runtime: 'claude-code',
        filesAndCommands: 'ask',
      });
    } finally {
      resetPermissionGate();
    }
  });

  it("reads the stop through the permission gate's reader, never off the file", async () => {
    // The gate's reader narrows an arriving agent's unscreened folder settings,
    // so what the file says must not start a session on its own.
    const dir = await mkdtemp(path.join(tmpdir(), 'agent-defaults-'));
    await writeManifest(dir, { ...BASE_MANIFEST, permissions: { filesAndCommands: 'autonomy' } });
    initPermissionGate({ readAgentPermissions: async () => undefined });
    try {
      expect(await readAgentExecutionDefaults(dir)).toEqual({ runtime: 'claude-code' });
    } finally {
      resetPermissionGate();
    }
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

describe('DorkOS declared standing defaults', () => {
  it('uses its configured model and trust override while preserving the global fallback', () => {
    const config = runtimes({
      defaultTrustStop: 'act',
      doe: {
        ...USER_CONFIG_DEFAULTS.runtimes.doe,
        defaultTrustStop: 'ask',
        inference: {
          source: 'local',
          provider: 'local',
          protocol: 'openai-responses',
          endpoint: 'http://127.0.0.1:11434/v1',
          model: 'local-model',
          contextWindow: 8192,
          maxOutputTokens: 1024,
        },
      },
    });
    const options = {
      runtimeType: 'doe',
      configSection: 'doe',
      runtimes: config,
      supportsEffort: false,
      permissionModes: DOE_CAPABILITIES.permissionModes.values,
    };
    expect(resolveSessionDefaults(options)).toEqual({
      model: 'local-model',
      permissionMode: 'default',
    });
    config.doe.defaultTrustStop = null;
    expect(resolveSessionDefaults(options)).toEqual({
      model: 'local-model',
      permissionMode: 'acceptEdits',
    });
    expect(
      describeExecutionDefaults({ doe: DOE_CAPABILITIES }, config).perRuntime[0]
    ).toMatchObject({ runtime: 'doe', model: 'local-model', trustStop: null });
  });
});
