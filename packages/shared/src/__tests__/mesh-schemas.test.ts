import { describe, it, expect } from 'vitest';
import {
  AgentManifestSchema,
  EnabledToolGroupsSchema,
  UpdateAgentRequestSchema,
  ResolveAgentsRequestSchema,
  ResolveAgentsResponseSchema,
  CreateAgentRequestSchema,
} from '../mesh-schemas.js';

// Minimal valid manifest fixture
const baseManifest = {
  id: 'agent-001',
  name: 'test-agent',
  runtime: 'claude-code' as const,
  registeredAt: new Date().toISOString(),
  registeredBy: 'system',
};

describe('AgentManifestSchema — persona field', () => {
  it('accepts a persona string within 4000 chars', () => {
    const result = AgentManifestSchema.parse({
      ...baseManifest,
      persona: 'You are backend-bot, an expert in REST API design.',
    });
    expect(result.persona).toBe('You are backend-bot, an expert in REST API design.');
  });

  it('accepts a persona string of exactly 4000 chars', () => {
    const longPersona = 'a'.repeat(4000);
    const result = AgentManifestSchema.parse({ ...baseManifest, persona: longPersona });
    expect(result.persona).toHaveLength(4000);
  });

  it('rejects a persona string longer than 4000 chars', () => {
    expect(() =>
      AgentManifestSchema.parse({ ...baseManifest, persona: 'a'.repeat(4001) })
    ).toThrow();
  });

  it('allows persona to be omitted (optional)', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.persona).toBeUndefined();
  });
});

describe('AgentManifestSchema — personaEnabled field', () => {
  it('defaults personaEnabled to true when omitted', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.personaEnabled).toBe(true);
  });

  it('accepts personaEnabled: false', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, personaEnabled: false });
    expect(result.personaEnabled).toBe(false);
  });

  it('accepts personaEnabled: true explicitly', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, personaEnabled: true });
    expect(result.personaEnabled).toBe(true);
  });
});

describe('AgentManifestSchema — color field', () => {
  it('accepts a hex color string', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, color: '#6366f1' });
    expect(result.color).toBe('#6366f1');
  });

  it('accepts an arbitrary CSS color string', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, color: 'rgb(255,0,0)' });
    expect(result.color).toBe('rgb(255,0,0)');
  });

  it('allows color to be omitted (optional)', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.color).toBeUndefined();
  });
});

describe('AgentManifestSchema — icon field', () => {
  it('accepts an emoji string', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, icon: '🤖' });
    expect(result.icon).toBe('🤖');
  });

  it('accepts an arbitrary string for icon', () => {
    const result = AgentManifestSchema.parse({ ...baseManifest, icon: 'bot' });
    expect(result.icon).toBe('bot');
  });

  it('allows icon to be omitted (optional)', () => {
    const result = AgentManifestSchema.parse(baseManifest);
    expect(result.icon).toBeUndefined();
  });
});

describe('UpdateAgentRequestSchema — new fields', () => {
  it('accepts a partial update with persona only', () => {
    const result = UpdateAgentRequestSchema.parse({ persona: 'You are a helpful assistant.' });
    expect(result.persona).toBe('You are a helpful assistant.');
  });

  it('accepts a partial update with personaEnabled only', () => {
    const result = UpdateAgentRequestSchema.parse({ personaEnabled: false });
    expect(result.personaEnabled).toBe(false);
  });

  it('accepts a partial update with color and icon', () => {
    const result = UpdateAgentRequestSchema.parse({ color: '#ff0000', icon: '🔴' });
    expect(result.color).toBe('#ff0000');
    expect(result.icon).toBe('🔴');
  });

  it('accepts all new fields together', () => {
    const result = UpdateAgentRequestSchema.parse({
      persona: 'You are a specialist.',
      personaEnabled: true,
      color: '#6366f1',
      icon: '🤖',
    });
    expect(result.persona).toBe('You are a specialist.');
    expect(result.personaEnabled).toBe(true);
    expect(result.color).toBe('#6366f1');
    expect(result.icon).toBe('🤖');
  });

  it('accepts empty object (all fields optional)', () => {
    const result = UpdateAgentRequestSchema.parse({});
    // Fields with defaults (description, capabilities, personaEnabled, enabledToolGroups)
    // will be included with their default values when parsed
    expect(result.name).toBeUndefined();
    expect(result.persona).toBeUndefined();
    expect(result.color).toBeUndefined();
    expect(result.icon).toBeUndefined();
  });

  it('still accepts existing fields (name, description, capabilities)', () => {
    const result = UpdateAgentRequestSchema.parse({
      name: 'new-name',
      description: 'Updated description',
      capabilities: ['read', 'write'],
    });
    expect(result.name).toBe('new-name');
    expect(result.description).toBe('Updated description');
    expect(result.capabilities).toEqual(['read', 'write']);
  });

  it('rejects persona longer than 4000 chars', () => {
    expect(() => UpdateAgentRequestSchema.parse({ persona: 'a'.repeat(4001) })).toThrow();
  });
});

describe('ResolveAgentsRequestSchema', () => {
  it('accepts a valid paths array with one entry', () => {
    const result = ResolveAgentsRequestSchema.parse({ paths: ['/agent/one'] });
    expect(result.paths).toEqual(['/agent/one']);
  });

  it('accepts exactly 20 paths', () => {
    const paths = Array.from({ length: 20 }, (_, i) => `/agent/${i}`);
    const result = ResolveAgentsRequestSchema.parse({ paths });
    expect(result.paths).toHaveLength(20);
  });

  it('rejects an empty paths array (min 1)', () => {
    expect(() => ResolveAgentsRequestSchema.parse({ paths: [] })).toThrow();
  });

  it('rejects more than 20 paths (max 20)', () => {
    const paths = Array.from({ length: 21 }, (_, i) => `/agent/${i}`);
    expect(() => ResolveAgentsRequestSchema.parse({ paths })).toThrow();
  });

  it('rejects paths containing empty strings', () => {
    expect(() => ResolveAgentsRequestSchema.parse({ paths: [''] })).toThrow();
  });

  it('rejects missing paths field', () => {
    expect(() => ResolveAgentsRequestSchema.parse({})).toThrow();
  });
});

describe('ResolveAgentsResponseSchema', () => {
  it('accepts a record mapping paths to manifests', () => {
    const manifest = AgentManifestSchema.parse(baseManifest);
    const result = ResolveAgentsResponseSchema.parse({
      agents: { '/agent/one': manifest },
    });
    expect(result.agents['/agent/one']).toBeDefined();
    expect(result.agents['/agent/one']?.id).toBe('agent-001');
  });

  it('accepts null values in the record (not found)', () => {
    const result = ResolveAgentsResponseSchema.parse({
      agents: { '/agent/missing': null },
    });
    expect(result.agents['/agent/missing']).toBeNull();
  });

  it('accepts a mixed record with some null and some manifest values', () => {
    const manifest = AgentManifestSchema.parse(baseManifest);
    const result = ResolveAgentsResponseSchema.parse({
      agents: { '/agent/one': manifest, '/agent/missing': null },
    });
    expect(result.agents['/agent/one']).not.toBeNull();
    expect(result.agents['/agent/missing']).toBeNull();
  });
});

describe('CreateAgentRequestSchema', () => {
  it('accepts a minimal request with path only', () => {
    const result = CreateAgentRequestSchema.parse({ path: '/path/to/agent' });
    expect(result.path).toBe('/path/to/agent');
  });

  it('defaults runtime to "claude-code" when omitted', () => {
    const result = CreateAgentRequestSchema.parse({ path: '/path/to/agent' });
    expect(result.runtime).toBe('claude-code');
  });

  it('accepts an explicit runtime value', () => {
    const result = CreateAgentRequestSchema.parse({
      path: '/path/to/agent',
      runtime: 'cursor',
    });
    expect(result.runtime).toBe('cursor');
  });

  it('accepts optional name and description', () => {
    const result = CreateAgentRequestSchema.parse({
      path: '/path/to/agent',
      name: 'my-agent',
      description: 'A helpful agent',
    });
    expect(result.name).toBe('my-agent');
    expect(result.description).toBe('A helpful agent');
  });

  it('rejects an empty path', () => {
    expect(() => CreateAgentRequestSchema.parse({ path: '' })).toThrow();
  });

  it('rejects a missing path', () => {
    expect(() => CreateAgentRequestSchema.parse({})).toThrow();
  });

  it('rejects an invalid runtime value', () => {
    expect(() =>
      CreateAgentRequestSchema.parse({ path: '/agent', runtime: 'unknown-runtime' })
    ).toThrow();
  });
});

describe('EnabledToolGroupsSchema', () => {
  it('defaults to empty object when parsed with undefined', () => {
    expect(EnabledToolGroupsSchema.parse(undefined)).toEqual({});
  });

  it('accepts partial overrides', () => {
    const result = EnabledToolGroupsSchema.parse({ pulse: false });
    expect(result).toEqual({ pulse: false });
  });

  it('accepts all fields', () => {
    const result = EnabledToolGroupsSchema.parse({
      pulse: true,
      relay: false,
      mesh: true,
      adapter: false,
    });
    expect(result).toEqual({ pulse: true, relay: false, mesh: true, adapter: false });
  });
});

describe('AgentManifestSchema with enabledToolGroups', () => {
  it('includes enabledToolGroups in parsed manifest', () => {
    const manifest = AgentManifestSchema.parse({
      ...baseManifest,
      enabledToolGroups: { pulse: false },
    });
    expect(manifest.enabledToolGroups).toEqual({ pulse: false });
  });

  it('defaults enabledToolGroups to empty object when omitted', () => {
    const manifest = AgentManifestSchema.parse(baseManifest);
    expect(manifest.enabledToolGroups).toEqual({});
  });
});

describe('UpdateAgentRequestSchema — enabledToolGroups', () => {
  it('accepts enabledToolGroups in a partial update', () => {
    const result = UpdateAgentRequestSchema.parse({ enabledToolGroups: { relay: false } });
    expect(result.enabledToolGroups).toEqual({ relay: false });
  });

  it('accepts enabledToolGroups as empty object', () => {
    const result = UpdateAgentRequestSchema.parse({ enabledToolGroups: {} });
    expect(result.enabledToolGroups).toEqual({});
  });

  it('accepts update without enabledToolGroups', () => {
    const result = UpdateAgentRequestSchema.parse({ name: 'new-name' });
    expect(result.name).toBe('new-name');
  });
});
