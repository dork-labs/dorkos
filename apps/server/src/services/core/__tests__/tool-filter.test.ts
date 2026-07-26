import { describe, it, expect } from 'vitest';
import { resolveToolConfig } from '../../runtimes/claude-code/tooling/tool-filter.js';
import type { ToolFilterDeps } from '../../runtimes/claude-code/tooling/tool-filter.js';

// Fixture: all features enabled, all global toggles on
const allEnabledDeps: ToolFilterDeps = {
  relayEnabled: true,
  tasksEnabled: true,
  globalConfig: {
    tasksTools: true,
    relayTools: true,
    meshTools: true,
    adapterTools: true,
  },
};

// Fixture: all features disabled
const allDisabledDeps: ToolFilterDeps = {
  relayEnabled: false,
  tasksEnabled: false,
  globalConfig: {
    tasksTools: false,
    relayTools: false,
    meshTools: false,
    adapterTools: false,
  },
};

describe('resolveToolConfig', () => {
  it('returns global defaults when agentConfig is undefined', () => {
    const result = resolveToolConfig(undefined, allEnabledDeps);
    expect(result).toEqual({ tasks: true, relay: true, mesh: true, adapter: true });
  });

  it('returns global defaults when agentConfig is empty object', () => {
    const result = resolveToolConfig({}, allEnabledDeps);
    expect(result).toEqual({ tasks: true, relay: true, mesh: true, adapter: true });
  });

  it('agent explicit false overrides global true for tasks', () => {
    const result = resolveToolConfig({ tasks: false }, allEnabledDeps);
    expect(result.tasks).toBe(false);
    expect(result.relay).toBe(true);
    expect(result.mesh).toBe(true);
    expect(result.adapter).toBe(true);
  });

  it('agent explicit false overrides global true for relay', () => {
    const result = resolveToolConfig({ relay: false }, allEnabledDeps);
    expect(result.relay).toBe(false);
    expect(result.tasks).toBe(true);
  });

  it('agent explicit false overrides global true for mesh', () => {
    const result = resolveToolConfig({ mesh: false }, allEnabledDeps);
    expect(result.mesh).toBe(false);
    expect(result.tasks).toBe(true);
  });

  it('agent explicit false overrides global true for adapter', () => {
    const result = resolveToolConfig({ adapter: false }, allEnabledDeps);
    expect(result.adapter).toBe(false);
    expect(result.tasks).toBe(true);
  });

  it('relay feature flag false overrides agent relay true', () => {
    const result = resolveToolConfig({ relay: true }, { ...allEnabledDeps, relayEnabled: false });
    expect(result.relay).toBe(false);
  });

  it('tasksEnabled false overrides agent tasks true', () => {
    const result = resolveToolConfig({ tasks: true }, { ...allEnabledDeps, tasksEnabled: false });
    expect(result.tasks).toBe(false);
  });

  it('adapter requires relayEnabled — false when relay feature flag off', () => {
    const result = resolveToolConfig({ adapter: true }, { ...allEnabledDeps, relayEnabled: false });
    expect(result.adapter).toBe(false);
  });

  it('mesh has no feature flag dependency — enabled even when relay/tasks off', () => {
    const result = resolveToolConfig(
      { mesh: true },
      {
        relayEnabled: false,
        tasksEnabled: false,
        globalConfig: { tasksTools: true, relayTools: true, meshTools: true, adapterTools: true },
      }
    );
    expect(result.mesh).toBe(true);
  });

  it('global config false disables when agent has no override', () => {
    const result = resolveToolConfig(undefined, {
      ...allEnabledDeps,
      globalConfig: { ...allEnabledDeps.globalConfig, tasksTools: false },
    });
    expect(result.tasks).toBe(false);
  });

  it('agent explicit true can override global false (when feature flag on)', () => {
    const result = resolveToolConfig(
      { relay: true },
      {
        relayEnabled: true,
        tasksEnabled: true,
        globalConfig: { tasksTools: true, relayTools: false, meshTools: true, adapterTools: true },
      }
    );
    expect(result.relay).toBe(true);
  });

  it('all disabled when all global config false and no agent overrides', () => {
    const result = resolveToolConfig(undefined, allDisabledDeps);
    expect(result).toEqual({ tasks: false, relay: false, mesh: false, adapter: false });
  });
});
