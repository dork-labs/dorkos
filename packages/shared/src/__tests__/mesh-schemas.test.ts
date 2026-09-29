import { describe, it, expect } from 'vitest';
import {
  AgentManifestFileSchema,
  AgentManifestSchema,
  AgentRuntimeSchema,
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
    // Fields with defaults (description, capabilities, personaEnabled)
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

  it('rejects more than 100 paths (max 100)', () => {
    const paths = Array.from({ length: 101 }, (_, i) => `/agent/${i}`);
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

describe('AgentRuntimeSchema', () => {
  it('accepts the execution runtimes DorkOS can run agents with', () => {
    expect(AgentRuntimeSchema.parse('claude-code')).toBe('claude-code');
    expect(AgentRuntimeSchema.parse('codex')).toBe('codex');
    expect(AgentRuntimeSchema.parse('opencode')).toBe('opencode');
  });

  it('rejects unknown runtime values', () => {
    expect(() => AgentRuntimeSchema.parse('unknown-runtime')).toThrow();
  });
});

describe('AgentManifestSchema — model and effort (execution defaults, E2)', () => {
  it('keeps a model and an effort the agent names', () => {
    const manifest = AgentManifestSchema.parse({
      ...baseManifest,
      model: 'opus',
      effort: 'high',
    });
    expect(manifest.model).toBe('opus');
    expect(manifest.effort).toBe('high');
  });

  it('leaves both absent when the agent names neither — absent means inherit', () => {
    const manifest = AgentManifestSchema.parse(baseManifest);
    expect(manifest.model).toBeUndefined();
    expect(manifest.effort).toBeUndefined();
  });

  it('accepts a model its runtime may not offer — validity is a warning, not a refusal', () => {
    // A Claude Code agent asking for a Codex model id. The write succeeds; the
    // mismatch is what the client's warning chip is for (design §3.4).
    const manifest = AgentManifestSchema.parse({
      ...baseManifest,
      runtime: 'claude-code',
      model: 'gpt-5.3-codex',
    });
    expect(manifest.model).toBe('gpt-5.3-codex');
  });

  it('accepts an effort on an OpenCode agent, which cannot honor one', () => {
    const manifest = AgentManifestSchema.parse({
      ...baseManifest,
      runtime: 'opencode',
      effort: 'xhigh',
    });
    expect(manifest.effort).toBe('xhigh');
  });

  it('survives a hand-edited manifest with a nonsense effort, dropping only that field', () => {
    // The whole agent must not vanish from the fleet over a typo in one
    // setting. A manifest that fails to parse makes `readManifest` return null,
    // which reads to every caller as "there is no agent here".
    const result = AgentManifestSchema.safeParse({
      ...baseManifest,
      model: 'sonnet',
      effort: 'ludicrous',
    });
    expect(result.success).toBe(true);
    expect(result.data?.model).toBe('sonnet');
    expect(result.data?.effort).toBeUndefined();
  });

  it('drops an empty model string the same way, rather than failing the manifest', () => {
    const result = AgentManifestSchema.safeParse({ ...baseManifest, model: '', effort: 'high' });
    expect(result.success).toBe(true);
    expect(result.data?.model).toBeUndefined();
    expect(result.data?.effort).toBe('high');
  });
});

describe('UpdateAgentRequestSchema — model and effort', () => {
  it('carries both on a partial update', () => {
    const result = UpdateAgentRequestSchema.parse({ model: 'sonnet', effort: 'low' });
    expect(result.model).toBe('sonnet');
    expect(result.effort).toBe('low');
  });

  it('accepts null for either, which is how a person says "back to the server default"', () => {
    const result = UpdateAgentRequestSchema.parse({ model: null, effort: null });
    expect(result.model).toBeNull();
    expect(result.effort).toBeNull();
  });

  it('refuses an effort off the ladder — a caller gets told, unlike a file on disk', () => {
    // The asymmetry is deliberate: the manifest tolerates a bad value because
    // nobody is standing there to be told, and a write does not.
    expect(UpdateAgentRequestSchema.safeParse({ effort: 'turbo' }).success).toBe(false);
    expect(UpdateAgentRequestSchema.safeParse({ model: '' }).success).toBe(false);
  });
});

describe('AgentManifestSchema — account (billing-account-ladder, DOR-1407)', () => {
  it('keeps the account id the agent is pinned to', () => {
    const manifest = AgentManifestSchema.parse({ ...baseManifest, account: 'acme-corp' });
    expect(manifest.account).toBe('acme-corp');
  });

  it('reads an absent account as "inherit", never as an error', () => {
    expect(AgentManifestSchema.parse(baseManifest).account).toBeUndefined();
  });

  it('survives a hand-edited manifest with a nonsense account, dropping only that field', () => {
    // Same degradation as model/effort, and for the same reason: an agent must
    // not vanish from the fleet over a typo in a billing setting. It loses the
    // override and falls back to the server default.
    const result = AgentManifestSchema.safeParse({
      ...baseManifest,
      name: 'still-here',
      account: 42,
    });
    expect(result.success).toBe(true);
    expect(result.data?.name).toBe('still-here');
    expect(result.data?.account).toBeUndefined();
  });

  it('degrades an empty account string rather than keeping an id nothing can match', () => {
    const result = AgentManifestSchema.safeParse({ ...baseManifest, account: '' });
    expect(result.success).toBe(true);
    expect(result.data?.account).toBeUndefined();
  });
});

describe('UpdateAgentRequestSchema — account', () => {
  it('accepts an account id, and null to go back to inheriting the default', () => {
    expect(UpdateAgentRequestSchema.parse({ account: 'acme-corp' }).account).toBe('acme-corp');
    expect(UpdateAgentRequestSchema.parse({ account: null }).account).toBeNull();
  });

  it('refuses an empty account — a caller gets told, unlike a file on disk', () => {
    expect(UpdateAgentRequestSchema.safeParse({ account: '' }).success).toBe(false);
  });
});

describe('AgentManifestFileSchema — the read-time fold of retired permission fields (spec agent-permissions D13)', () => {
  // A legacy manifest file keeps meaning what a person set: each retired field
  // becomes areas of the agent's permissions, and the field disappears. Every
  // row reads the parse, never the fold function alone, because the parse is
  // what every file read goes through.
  const ALL_BLOCKED = {
    rooms: 'blocked',
    tasks: 'blocked',
    agents: 'blocked',
    messages: 'blocked',
    connections: 'blocked',
    packages: 'blocked',
    settings: 'blocked',
    safety: 'blocked',
    permissions: 'blocked',
    reach: 'blocked',
  };

  it('folds roomsManage: true into Rooms Allowed and drops the field', () => {
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      enabledToolGroups: { roomsManage: true },
    });
    expect(m.permissions).toEqual({ areas: { rooms: 'allowed' } });
    expect(m).not.toHaveProperty('enabledToolGroups');
  });

  it('folds roomsManage: false into Rooms Blocked (an explicit choice)', () => {
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      enabledToolGroups: { roomsManage: false },
    });
    expect(m.permissions).toEqual({ areas: { rooms: 'blocked' } });
  });

  it.each([
    ['tasks', 'tasks'],
    ['relay', 'messages'],
    ['mesh', 'agents'],
    ['adapter', 'connections'],
  ])('folds the %s switch into %s: true is Allowed, false is Blocked', (key, area) => {
    expect(
      AgentManifestFileSchema.parse({ ...baseManifest, enabledToolGroups: { [key]: true } })
        .permissions
    ).toEqual({ areas: { [area]: 'allowed' } });
    expect(
      AgentManifestFileSchema.parse({ ...baseManifest, enabledToolGroups: { [key]: false } })
        .permissions
    ).toEqual({ areas: { [area]: 'blocked' } });
  });

  it('adds no permissions when no switch is set (inherit), and drops the field', () => {
    const m = AgentManifestFileSchema.parse({ ...baseManifest, enabledToolGroups: {} });
    expect(m.permissions).toBeUndefined();
    expect(m).not.toHaveProperty('enabledToolGroups');
  });

  it("folds tierCeiling: 'observe' into every area Blocked", () => {
    const m = AgentManifestFileSchema.parse({ ...baseManifest, tierCeiling: 'observe' });
    expect(m.permissions).toEqual({ areas: ALL_BLOCKED });
    expect(m).not.toHaveProperty('tierCeiling');
  });

  it.each(['act', 'destructive'])("folds tierCeiling: '%s' into nothing", (ceiling) => {
    // `act` never needed a fold: destructive actions ask by the permission
    // model's own rule. `destructive` never limited anything.
    const m = AgentManifestFileSchema.parse({ ...baseManifest, tierCeiling: ceiling });
    expect(m.permissions).toBeUndefined();
    expect(m).not.toHaveProperty('tierCeiling');
  });

  it('lets the ceiling outrank a documentation switch that was on', () => {
    // The ceiling was the one legacy field that really limited the agent; a
    // switch that was only ever about docs must not widen a capped agent.
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      tierCeiling: 'observe',
      enabledToolGroups: { relay: true, roomsManage: true },
    });
    expect(m.permissions?.areas).toEqual(ALL_BLOCKED);
  });

  it('never overwrites an area set explicitly, whatever the legacy fields say', () => {
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      enabledToolGroups: { roomsManage: true, tasks: false },
      permissions: {
        areas: { rooms: 'ask', tasks: 'allowed' },
        actions: { 'rooms.merge': 'blocked' },
      },
    });
    expect(m.permissions).toEqual({
      areas: { rooms: 'ask', tasks: 'allowed' },
      actions: { 'rooms.merge': 'blocked' },
    });
  });

  it("keeps a phase-1 Rooms setting beside tierCeiling: 'observe', and Blocks the rest", () => {
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      tierCeiling: 'observe',
      permissions: { areas: { rooms: 'allowed' } },
    });
    expect(m.permissions?.areas).toEqual({ ...ALL_BLOCKED, rooms: 'allowed' });
  });

  it('drops a legacy value of the wrong type as absent', () => {
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      tierCeiling: 'everything',
      enabledToolGroups: { tasks: 'yes' },
    });
    expect(m.permissions).toBeUndefined();
  });

  it('parses an area key a newer build knows', () => {
    const m = AgentManifestFileSchema.parse({
      ...baseManifest,
      permissions: { areas: { future: 'allowed' } },
    });
    expect(m.permissions?.areas).toEqual({ future: 'allowed' });
  });

  it('fails the parse loudly on a state that is not one of the three', () => {
    expect(
      AgentManifestFileSchema.safeParse({
        ...baseManifest,
        permissions: { areas: { rooms: 'yes' } },
      }).success
    ).toBe(false);
    expect(
      AgentManifestSchema.safeParse({ ...baseManifest, permissions: { areas: { rooms: 'yes' } } })
        .success
    ).toBe(false);
  });

  it('never lets the generic agent PATCH carry permissions or the retired fields', () => {
    const parsed = UpdateAgentRequestSchema.parse({
      permissions: { areas: { rooms: 'allowed' } },
      enabledToolGroups: { roomsManage: true, tasks: false },
      tierCeiling: 'observe',
    });
    expect(parsed).not.toHaveProperty('permissions');
    expect(parsed).not.toHaveProperty('enabledToolGroups');
    expect(parsed).not.toHaveProperty('tierCeiling');
  });
});
