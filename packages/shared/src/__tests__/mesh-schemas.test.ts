import { describe, it, expect } from 'vitest';
import {
  AgentManifestFileSchema,
  AgentManifestSchema,
  UpdateAgentRequestSchema,
  ResolveAgentsRequestSchema,
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
  it('rejects a persona string longer than 4000 chars', () => {
    expect(() =>
      AgentManifestSchema.parse({ ...baseManifest, persona: 'a'.repeat(4001) })
    ).toThrow();
  });
});

describe('UpdateAgentRequestSchema — new fields', () => {
  it('rejects persona longer than 4000 chars', () => {
    expect(() => UpdateAgentRequestSchema.parse({ persona: 'a'.repeat(4001) })).toThrow();
  });
});

describe('ResolveAgentsRequestSchema', () => {
  it('rejects more than 100 paths (max 100)', () => {
    const paths = Array.from({ length: 101 }, (_, i) => `/agent/${i}`);
    expect(() => ResolveAgentsRequestSchema.parse({ paths })).toThrow();
  });
});

describe('CreateAgentRequestSchema', () => {
  it('rejects an empty path', () => {
    expect(() => CreateAgentRequestSchema.parse({ path: '' })).toThrow();
  });
});

describe('AgentManifestSchema — model and effort (execution defaults, E2)', () => {
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
});

describe('UpdateAgentRequestSchema — model and effort', () => {
  it('refuses an effort off the ladder — a caller gets told, unlike a file on disk', () => {
    // The asymmetry is deliberate: the manifest tolerates a bad value because
    // nobody is standing there to be told, and a write does not.
    expect(UpdateAgentRequestSchema.safeParse({ effort: 'turbo' }).success).toBe(false);
    expect(UpdateAgentRequestSchema.safeParse({ model: '' }).success).toBe(false);
  });
});

describe('AgentManifestSchema — account (billing-account-ladder, DOR-1407)', () => {
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
});

describe('UpdateAgentRequestSchema — account', () => {
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
    // An observe ceiling blocks Extension tools too (DOR-2685): a capped agent
    // must not gain the tools an extension adds.
    extensions: 'blocked',
    // Own chat (DOR-2732) is an act-tier action, which an observe ceiling never allowed.
    own_chat: 'blocked',
    // To-dos (DOR-3936): an observe ceiling never allowed making or changing one.
    todos: 'blocked',
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
