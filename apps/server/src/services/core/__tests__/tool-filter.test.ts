import { describe, it, expect } from 'vitest';
import { resolveToolConfig, buildAllowedTools } from '../../runtimes/claude-code/tool-filter.js';
import type { ToolFilterDeps } from '../../runtimes/claude-code/tool-filter.js';

// Fixture: all features enabled, all global toggles on
const allEnabledDeps: ToolFilterDeps = {
  relayEnabled: true,
  pulseEnabled: true,
  globalConfig: {
    pulseTools: true,
    relayTools: true,
    meshTools: true,
    adapterTools: true,
  },
};

// Fixture: all features disabled
const allDisabledDeps: ToolFilterDeps = {
  relayEnabled: false,
  pulseEnabled: false,
  globalConfig: {
    pulseTools: false,
    relayTools: false,
    meshTools: false,
    adapterTools: false,
  },
};

describe('resolveToolConfig', () => {
  it('returns global defaults when agentConfig is undefined', () => {
    const result = resolveToolConfig(undefined, allEnabledDeps);
    expect(result).toEqual({ pulse: true, relay: true, mesh: true, adapter: true });
  });

  it('returns global defaults when agentConfig is empty object', () => {
    const result = resolveToolConfig({}, allEnabledDeps);
    expect(result).toEqual({ pulse: true, relay: true, mesh: true, adapter: true });
  });

  it('agent explicit false overrides global true for pulse', () => {
    const result = resolveToolConfig({ pulse: false }, allEnabledDeps);
    expect(result.pulse).toBe(false);
    expect(result.relay).toBe(true);
    expect(result.mesh).toBe(true);
    expect(result.adapter).toBe(true);
  });

  it('agent explicit false overrides global true for relay', () => {
    const result = resolveToolConfig({ relay: false }, allEnabledDeps);
    expect(result.relay).toBe(false);
    expect(result.pulse).toBe(true);
  });

  it('agent explicit false overrides global true for mesh', () => {
    const result = resolveToolConfig({ mesh: false }, allEnabledDeps);
    expect(result.mesh).toBe(false);
    expect(result.pulse).toBe(true);
  });

  it('agent explicit false overrides global true for adapter', () => {
    const result = resolveToolConfig({ adapter: false }, allEnabledDeps);
    expect(result.adapter).toBe(false);
    expect(result.pulse).toBe(true);
  });

  it('relay feature flag false overrides agent relay true', () => {
    const result = resolveToolConfig({ relay: true }, { ...allEnabledDeps, relayEnabled: false });
    expect(result.relay).toBe(false);
  });

  it('pulseEnabled false overrides agent pulse true', () => {
    const result = resolveToolConfig({ pulse: true }, { ...allEnabledDeps, pulseEnabled: false });
    expect(result.pulse).toBe(false);
  });

  it('adapter requires relayEnabled — false when relay feature flag off', () => {
    const result = resolveToolConfig({ adapter: true }, { ...allEnabledDeps, relayEnabled: false });
    expect(result.adapter).toBe(false);
  });

  it('mesh has no feature flag dependency — enabled even when relay/pulse off', () => {
    const result = resolveToolConfig(
      { mesh: true },
      {
        relayEnabled: false,
        pulseEnabled: false,
        globalConfig: { pulseTools: true, relayTools: true, meshTools: true, adapterTools: true },
      }
    );
    expect(result.mesh).toBe(true);
  });

  it('global config false disables when agent has no override', () => {
    const result = resolveToolConfig(undefined, {
      ...allEnabledDeps,
      globalConfig: { ...allEnabledDeps.globalConfig, pulseTools: false },
    });
    expect(result.pulse).toBe(false);
  });

  it('agent explicit true can override global false (when feature flag on)', () => {
    const result = resolveToolConfig(
      { relay: true },
      {
        relayEnabled: true,
        pulseEnabled: true,
        globalConfig: { pulseTools: true, relayTools: false, meshTools: true, adapterTools: true },
      }
    );
    expect(result.relay).toBe(true);
  });

  it('all disabled when all global config false and no agent overrides', () => {
    const result = resolveToolConfig(undefined, allDisabledDeps);
    expect(result).toEqual({ pulse: false, relay: false, mesh: false, adapter: false });
  });
});

describe('buildAllowedTools', () => {
  it('returns undefined when all domains enabled', () => {
    const result = buildAllowedTools({ pulse: true, relay: true, mesh: true, adapter: true });
    expect(result).toBeUndefined();
  });

  it('always includes core tools when any domain is disabled', () => {
    const result = buildAllowedTools({ pulse: false, relay: false, mesh: false, adapter: false });
    expect(result).toContain('mcp__dorkos__ping');
    expect(result).toContain('mcp__dorkos__get_server_info');
    expect(result).toContain('mcp__dorkos__get_session_count');
    expect(result).toContain('mcp__dorkos__get_agent');
  });

  it('excludes pulse tools when pulse=false', () => {
    const result = buildAllowedTools({ pulse: false, relay: true, mesh: true, adapter: true })!;
    expect(result).not.toContain('mcp__dorkos__pulse_list_schedules');
    expect(result).not.toContain('mcp__dorkos__pulse_create_schedule');
    expect(result).not.toContain('mcp__dorkos__pulse_update_schedule');
    expect(result).not.toContain('mcp__dorkos__pulse_delete_schedule');
    expect(result).not.toContain('mcp__dorkos__pulse_get_run_history');
  });

  it('includes pulse tools when pulse=true (with another domain disabled)', () => {
    const result = buildAllowedTools({ pulse: true, relay: false, mesh: false, adapter: false })!;
    expect(result).toContain('mcp__dorkos__pulse_list_schedules');
    expect(result).toContain('mcp__dorkos__pulse_create_schedule');
  });

  it('excludes relay tools when relay=false', () => {
    const result = buildAllowedTools({ pulse: true, relay: false, mesh: true, adapter: true })!;
    expect(result).not.toContain('mcp__dorkos__relay_send');
    expect(result).not.toContain('mcp__dorkos__relay_inbox');
    expect(result).not.toContain('mcp__dorkos__relay_list_endpoints');
    expect(result).not.toContain('mcp__dorkos__relay_register_endpoint');
    expect(result).not.toContain('mcp__dorkos__relay_send_and_wait');
    expect(result).not.toContain('mcp__dorkos__relay_send_async');
    expect(result).not.toContain('mcp__dorkos__relay_unregister_endpoint');
  });

  it('excludes trace tools when relay=false (implicit grouping)', () => {
    const result = buildAllowedTools({ pulse: true, relay: false, mesh: true, adapter: true })!;
    expect(result).not.toContain('mcp__dorkos__relay_get_trace');
    expect(result).not.toContain('mcp__dorkos__relay_get_metrics');
  });

  it('includes relay + trace tools when relay=true (with another domain disabled)', () => {
    const result = buildAllowedTools({ pulse: false, relay: true, mesh: true, adapter: true })!;
    expect(result).toContain('mcp__dorkos__relay_send');
    expect(result).toContain('mcp__dorkos__relay_inbox');
    expect(result).toContain('mcp__dorkos__relay_send_and_wait');
    expect(result).toContain('mcp__dorkos__relay_get_trace');
    expect(result).toContain('mcp__dorkos__relay_get_metrics');
    expect(result).toContain('mcp__dorkos__relay_send_async');
    expect(result).toContain('mcp__dorkos__relay_unregister_endpoint');
  });

  it('includes relay_send_async and relay_unregister_endpoint when relay=true', () => {
    // Purpose: ensures new relay tools follow the relay toggle exactly.
    const result = buildAllowedTools({ pulse: false, relay: true, mesh: true, adapter: true })!;
    expect(result).toContain('mcp__dorkos__relay_send_async');
    expect(result).toContain('mcp__dorkos__relay_unregister_endpoint');
  });

  it('excludes relay_send_async and relay_unregister_endpoint when relay=false', () => {
    // Purpose: verifies relay feature gate applies to new tools.
    const result = buildAllowedTools({ pulse: true, relay: false, mesh: true, adapter: true })!;
    expect(result).not.toContain('mcp__dorkos__relay_send_async');
    expect(result).not.toContain('mcp__dorkos__relay_unregister_endpoint');
  });

  it('excludes mesh tools when mesh=false', () => {
    const result = buildAllowedTools({ pulse: true, relay: true, mesh: false, adapter: true })!;
    expect(result).not.toContain('mcp__dorkos__mesh_discover');
    expect(result).not.toContain('mcp__dorkos__mesh_register');
    expect(result).not.toContain('mcp__dorkos__mesh_list');
    expect(result).not.toContain('mcp__dorkos__mesh_query_topology');
  });

  it('excludes binding tools when adapter=false (implicit grouping)', () => {
    const result = buildAllowedTools({ pulse: true, relay: true, mesh: true, adapter: false })!;
    expect(result).not.toContain('mcp__dorkos__binding_list');
    expect(result).not.toContain('mcp__dorkos__binding_create');
    expect(result).not.toContain('mcp__dorkos__binding_delete');
  });

  it('excludes adapter tools when adapter=false', () => {
    const result = buildAllowedTools({ pulse: true, relay: true, mesh: true, adapter: false })!;
    expect(result).not.toContain('mcp__dorkos__relay_list_adapters');
    expect(result).not.toContain('mcp__dorkos__relay_enable_adapter');
    expect(result).not.toContain('mcp__dorkos__relay_disable_adapter');
    expect(result).not.toContain('mcp__dorkos__relay_reload_adapters');
  });

  it('includes adapter + binding tools when adapter=true (with another domain disabled)', () => {
    const result = buildAllowedTools({ pulse: false, relay: true, mesh: true, adapter: true })!;
    expect(result).toContain('mcp__dorkos__relay_list_adapters');
    expect(result).toContain('mcp__dorkos__binding_list');
    expect(result).toContain('mcp__dorkos__binding_create');
    expect(result).toContain('mcp__dorkos__binding_delete');
  });

  it('returns only core tools when all domains are disabled', () => {
    const result = buildAllowedTools({ pulse: false, relay: false, mesh: false, adapter: false })!;
    // Should be exactly the 4 core tools
    expect(result).toHaveLength(4);
    expect(result).toContain('mcp__dorkos__ping');
    expect(result).toContain('mcp__dorkos__get_server_info');
    expect(result).toContain('mcp__dorkos__get_session_count');
    expect(result).toContain('mcp__dorkos__get_agent');
  });

  it('returns a non-empty array when at least one domain is disabled', () => {
    const result = buildAllowedTools({ pulse: false, relay: true, mesh: true, adapter: true });
    expect(result).toBeDefined();
    expect(Array.isArray(result)).toBe(true);
    expect(result!.length).toBeGreaterThan(0);
  });

  it('does not duplicate tools in the result', () => {
    const result = buildAllowedTools({ pulse: true, relay: true, mesh: false, adapter: false })!;
    const unique = new Set(result);
    expect(unique.size).toBe(result.length);
  });
});

describe('resolveToolConfig + buildAllowedTools integration', () => {
  it('returns undefined allowedTools when all deps enabled and no agent overrides', () => {
    const config = resolveToolConfig(undefined, allEnabledDeps);
    const allowed = buildAllowedTools(config);
    expect(allowed).toBeUndefined();
  });

  it('filters correctly via full pipeline when agent disables pulse', () => {
    const config = resolveToolConfig({ pulse: false }, allEnabledDeps);
    const allowed = buildAllowedTools(config)!;
    expect(allowed).toBeDefined();
    expect(allowed).not.toContain('mcp__dorkos__pulse_list_schedules');
    expect(allowed).toContain('mcp__dorkos__ping');
    expect(allowed).toContain('mcp__dorkos__relay_send');
  });

  it('filters correctly via full pipeline when relay feature flag off', () => {
    const config = resolveToolConfig(undefined, { ...allEnabledDeps, relayEnabled: false });
    const allowed = buildAllowedTools(config)!;
    expect(allowed).toBeDefined();
    // relay, adapter, and trace tools all excluded
    expect(allowed).not.toContain('mcp__dorkos__relay_send');
    expect(allowed).not.toContain('mcp__dorkos__relay_get_trace');
    expect(allowed).not.toContain('mcp__dorkos__relay_list_adapters');
    expect(allowed).not.toContain('mcp__dorkos__binding_list');
    // mesh still included (no feature flag dependency)
    expect(allowed).toContain('mcp__dorkos__mesh_list');
  });
});
