/**
 * Tests for {@link applyShape} (DOR-355, spec §5 + §7).
 *
 * Three concerns, all against injected fakes (no disk, no config singleton):
 *   (a) an all-present manifest enables every extension, creates every schedule
 *       enabled, offers the default agent, and records the active Shape;
 *   (b) EACH degradation row in spec §7 emits exactly its warning with ok:true
 *       (and the one fatal case throws);
 *   (c) applying twice creates no duplicate schedule and writes identical config.
 */
import { describe, expect, it, vi } from 'vitest';
import type { ShapePackageManifest } from '@dorkos/marketplace';
import { MarketplacePackageManifestSchema } from '@dorkos/marketplace';
import type { CreateTaskRequest } from '@dorkos/shared/schemas';
import {
  applyShape,
  ShapeNotInstalledError,
  type ApplyShapeDeps,
  type RegisteredAgentView,
} from '../apply-shape.js';

/** Parse a partial manifest through the union so all defaults + cross-field rules apply. */
function buildManifest(overrides: Record<string, unknown> = {}): ShapePackageManifest {
  return MarketplacePackageManifestSchema.parse({
    schemaVersion: 1,
    name: 'test-shape',
    version: '1.0.0',
    type: 'shape',
    description: 'A test shape.',
    author: 'test',
    ...overrides,
  }) as ShapePackageManifest;
}

/** A fully-satisfiable Linear-Ops-shaped manifest used by the happy-path + idempotency tests. */
function linearOpsManifest(): ShapePackageManifest {
  return buildManifest({
    activates: ['linear-issues'],
    layout: { sidebarOpen: true, sidebarTab: 'overview', focusDashboardSections: ['x:y'] },
    agents: [
      {
        ref: 'linear-tender',
        affinity: 'default',
        matchName: 'Linear Tender',
        template: { displayName: 'Linear Tender', persona: 'tend the tracker' },
      },
    ],
    schedules: [
      {
        name: 'inbox-tick',
        description: 'poll the inbox',
        prompt: 'run one tick',
        cron: '*/15 * * * *',
        agentRef: 'linear-tender',
        permissionMode: 'acceptEdits',
      },
    ],
    connections: [
      { kind: 'extension-secret', extension: 'linear-issues', secret: 'linear_api_key' },
    ],
  });
}

/** A registered agent that satisfies the Linear Tender entry by display name. */
const LINEAR_TENDER_AGENT: RegisteredAgentView = {
  id: 'agent-tender',
  name: 'linear-tender',
  displayName: 'Linear Tender',
  projectPath: '/projects/linear-tender',
};

/** A schedule as tracked by the fake service — mirrors the real store's row. */
interface FakeSchedule {
  name: string;
  /** `null` = global (unbound); a concrete id = agent-bound. */
  agentId: string | null;
  enabled: boolean;
}

/** Configurable fakes for {@link ApplyShapeDeps}. Every collaborator is observable. */
function makeDeps(opts: {
  manifest: ShapePackageManifest | null;
  presentExtensions?: string[];
  enablableExtensions?: string[];
  setSecrets?: [string, string][];
  registeredAgents?: RegisteredAgentView[];
  existingSchedules?: FakeSchedule[];
  autoFollowAgent?: boolean;
}) {
  const present = new Set(opts.presentExtensions ?? []);
  const enablable = new Set(opts.enablableExtensions ?? opts.presentExtensions ?? []);
  const setSecrets = new Set((opts.setSecrets ?? []).map(([e, k]) => `${e}:${k}`));
  // The fake store, keyed by name (the real service's cross-scope identity).
  const schedules: FakeSchedule[] = (opts.existingSchedules ?? []).map((s) => ({ ...s }));

  const createSchedule = vi.fn(async (req: CreateTaskRequest) => {
    schedules.push({
      name: req.name,
      agentId: req.target === 'global' ? null : req.target,
      enabled: req.enabled ?? true,
    });
  });
  const rebindSchedule = vi.fn(
    async (name: string, rebind: { agentId: string; enabled: boolean }) => {
      const existing = schedules.find((s) => s.name === name);
      if (existing) {
        existing.agentId = rebind.agentId;
        existing.enabled = rebind.enabled;
      }
    }
  );
  const enable = vi.fn(async (id: string) => (enablable.has(id) ? { reloadRequired: true } : null));
  const setActiveShape = vi.fn();

  const deps: ApplyShapeDeps = {
    manifestResolver: { resolve: vi.fn(async () => opts.manifest) },
    extensionManager: {
      get: (id) => (present.has(id) ? { manifest: { serverCapabilities: {} } } : undefined),
      enable,
    },
    secretChecker: { isSet: async (ext, key) => setSecrets.has(`${ext}:${key}`) },
    agentRegistry: { listWithPaths: () => opts.registeredAgents ?? [] },
    scheduleService: {
      // Existence is by NAME across every scope; `agentId` distinguishes a
      // still-waiting global copy (re-bindable) from an already-bound one.
      listSchedules: () => schedules.map((s) => ({ ...s })),
      createSchedule,
      rebindSchedule,
    },
    configStore: {
      getShapePrefs: () => ({
        active: null,
        agentDefaults: {},
        autoFollowAgent: opts.autoFollowAgent ?? false,
      }),
      setActiveShape,
    },
  };
  return { deps, createSchedule, rebindSchedule, enable, setActiveShape, schedules };
}

describe('applyShape', () => {
  it('(a) all-present: enables extensions, creates enabled schedules, offers the default agent, records active', async () => {
    const { deps, createSchedule, enable, setActiveShape } = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [LINEAR_TENDER_AGENT],
    });

    const result = await applyShape('linear-ops', deps);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.applied.activatedExtensions).toEqual(['linear-issues']);
    expect(enable).toHaveBeenCalledWith('linear-issues');
    // The schedule is created bound to the resolved agent, enabled.
    expect(result.applied.schedulesCreated).toEqual(['inbox-tick']);
    expect(createSchedule).toHaveBeenCalledTimes(1);
    const req = createSchedule.mock.calls[0][0];
    expect(req.target).toBe('agent-tender');
    expect(req.enabled).toBe(true);
    // The default agent is satisfied → surfaced as the arrival offer (not auto-followed).
    expect(result.offeredAgents).toHaveLength(1);
    expect(result.offeredAgents[0]).toMatchObject({
      ref: 'linear-tender',
      satisfied: true,
      arrival: true,
      autoFollow: false,
      agentId: 'agent-tender',
    });
    // Chrome round-trips for the client to apply.
    expect(result.applied.layout.sidebarTab).toBe('overview');
    // Active Shape recorded.
    expect(setActiveShape).toHaveBeenCalledWith('linear-ops');
  });

  it('(a) auto-follows the satisfied default agent when the user opted in', async () => {
    const { deps } = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [LINEAR_TENDER_AGENT],
      autoFollowAgent: true,
    });

    const result = await applyShape('linear-ops', deps);
    expect(result.offeredAgents[0].autoFollow).toBe(true);
  });

  // === (b) Degradation rows (spec §7) — one warning each, still ok ===

  it('(b) Shape not installed → the ONE fatal case throws ShapeNotInstalledError', async () => {
    const { deps } = makeDeps({ manifest: null });
    await expect(applyShape('ghost', deps)).rejects.toBeInstanceOf(ShapeNotInstalledError);
    await expect(applyShape('ghost', deps)).rejects.toThrow("Shape 'ghost' is not installed");
  });

  it('(b) activated extension not found → skip + warn, layout still applies', async () => {
    const { deps, enable } = makeDeps({
      manifest: buildManifest({ activates: ['missing-ext'] }),
      presentExtensions: [],
    });
    const result = await applyShape('s', deps);
    expect(result.ok).toBe(true);
    expect(enable).not.toHaveBeenCalled();
    expect(result.applied.activatedExtensions).toEqual([]);
    expect(result.warnings).toContain(
      "Extension 'missing-ext' not found; install it to complete this Shape"
    );
  });

  it('(b) bundled inline extension failed to compile → present but not enablable → warn', async () => {
    const { deps } = makeDeps({
      manifest: buildManifest({ activates: ['broken-ext'] }),
      presentExtensions: ['broken-ext'],
      enablableExtensions: [], // present via get(), but enable() returns null
    });
    const result = await applyShape('s', deps);
    expect(result.ok).toBe(true);
    expect(result.applied.activatedExtensions).toEqual([]);
    expect(result.warnings).toContain("Extension 'broken-ext' failed to compile");
  });

  it('(b) extension secret unset → warn (no block)', async () => {
    const { deps } = makeDeps({
      manifest: buildManifest({
        activates: ['linear-issues'],
        connections: [
          { kind: 'extension-secret', extension: 'linear-issues', secret: 'linear_api_key' },
        ],
      }),
      presentExtensions: ['linear-issues'],
      setSecrets: [], // secret NOT set
    });
    const result = await applyShape('s', deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain(
      "Connection 'linear_api_key' for 'linear-issues' needs setup"
    );
  });

  it('(b) MCP server connection absent → surface setup hint', async () => {
    const { deps } = makeDeps({
      manifest: buildManifest({
        connections: [{ kind: 'mcp-server', server: 'linear-mcp' }],
      }),
    });
    const result = await applyShape('s', deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("MCP server 'linear-mcp' not configured");
  });

  it('(b) suggested/default agent absent → not created, returned as an offer + warn', async () => {
    const { deps } = makeDeps({
      manifest: buildManifest({
        agents: [{ ref: 'tender', affinity: 'default', template: { displayName: 'Tender' } }],
      }),
      registeredAgents: [], // no agent matches
    });
    const result = await applyShape('s', deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("Agent 'tender' not present — offered");
    expect(result.offeredAgents[0]).toMatchObject({
      ref: 'tender',
      satisfied: false,
      arrival: true,
    });
  });

  it('(b) schedule target agent absent → schedule created disabled + warn', async () => {
    const { deps, createSchedule } = makeDeps({
      manifest: buildManifest({
        agents: [{ ref: 'tender', affinity: 'default', template: { displayName: 'T' } }],
        schedules: [
          {
            name: 'tick',
            description: 'poll',
            prompt: 'go',
            cron: '*/5 * * * *',
            agentRef: 'tender',
            permissionMode: 'acceptEdits',
          },
        ],
      }),
      registeredAgents: [], // the agent the schedule targets is missing
    });
    const result = await applyShape('s', deps);
    expect(result.ok).toBe(true);
    expect(result.warnings).toContain("Schedule 'tick' created disabled — agent 'tender' missing");
    expect(result.applied.schedulesCreated).toEqual(['tick']);
    const req = createSchedule.mock.calls[0][0];
    expect(req.enabled).toBe(false);
    expect(req.target).toBe('global');
  });

  // === (c) Idempotency ===

  it('(c) applying twice creates no duplicate schedule and writes identical config', async () => {
    const shared = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [LINEAR_TENDER_AGENT],
    });

    const first = await applyShape('linear-ops', shared.deps);
    const second = await applyShape('linear-ops', shared.deps);

    // First apply creates the schedule already bound; the second is a no-op — it
    // is neither re-created (name match) nor re-bound (already agent-bound).
    expect(first.applied.schedulesCreated).toEqual(['inbox-tick']);
    expect(second.applied.schedulesCreated).toEqual([]);
    expect(second.applied.schedulesRebound).toEqual([]);
    expect(shared.createSchedule).toHaveBeenCalledTimes(1);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    // Extensions + offers are identical across applies.
    expect(second.applied.activatedExtensions).toEqual(first.applied.activatedExtensions);
    expect(second.offeredAgents).toEqual(first.offeredAgents);
    // Active Shape recorded identically both times.
    expect(shared.setActiveShape).toHaveBeenNthCalledWith(1, 'linear-ops');
    expect(shared.setActiveShape).toHaveBeenNthCalledWith(2, 'linear-ops');
  });

  it('(c) re-binds + enables the waiting schedule when its agent appears between applies', async () => {
    // First apply: the offered agent does not exist yet, so the schedule is
    // created globally-disabled. Then the user accepts the offer (the agent now
    // exists) and re-applies: the SAME schedule must re-target to the agent's id
    // and enable — the whole point of the Shape's tick. No duplicate is created
    // (existence is by name across scopes), and the earlier global copy is the
    // one that flips.
    const registeredAgents: RegisteredAgentView[] = [];
    const shared = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents,
    });

    const first = await applyShape('linear-ops', shared.deps);
    expect(first.applied.schedulesCreated).toEqual(['inbox-tick']);
    expect(first.applied.schedulesRebound).toEqual([]);
    expect(shared.createSchedule.mock.calls[0][0]).toMatchObject({
      target: 'global',
      enabled: false,
    });
    // It landed global + disabled (waiting on its agent).
    expect(shared.schedules).toEqual([{ name: 'inbox-tick', agentId: null, enabled: false }]);

    // The offered agent is created between applies.
    registeredAgents.push(LINEAR_TENDER_AGENT);

    const second = await applyShape('linear-ops', shared.deps);
    // Re-bound, not re-created: no duplicate, and the flip is reported.
    expect(second.applied.schedulesCreated).toEqual([]);
    expect(second.applied.schedulesRebound).toEqual(['inbox-tick']);
    expect(shared.createSchedule).toHaveBeenCalledTimes(1);
    expect(shared.rebindSchedule).toHaveBeenCalledTimes(1);
    expect(shared.rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-tender',
      enabled: true,
    });
    // The single schedule is now agent-bound and enabled — the tick turns on.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: true },
    ]);
    // And no repeat of the created-disabled warning for a schedule that was not created.
    expect(second.warnings).not.toContain(
      "Schedule 'inbox-tick' created disabled — agent 'linear-tender' missing"
    );
  });

  // === (d) Re-bind guards ===

  it('(d) never force-enables a schedule the user disabled after it was agent-bound', async () => {
    // The schedule already found its agent and the user turned it OFF — an
    // explicit choice. A later apply must NOT resurrect it.
    const shared = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [LINEAR_TENDER_AGENT],
      existingSchedules: [{ name: 'inbox-tick', agentId: 'agent-tender', enabled: false }],
    });

    const result = await applyShape('linear-ops', shared.deps);

    expect(result.applied.schedulesCreated).toEqual([]);
    expect(result.applied.schedulesRebound).toEqual([]);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    expect(shared.createSchedule).not.toHaveBeenCalled();
    // Left exactly as the user set it — still bound, still disabled.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false },
    ]);
  });

  it('(d) leaves a waiting schedule global when the registered agent does not match', async () => {
    // A schedule waits global/disabled, but the only registered agent does not
    // satisfy the entry's matchName — nothing re-binds.
    const shared = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [
        { id: 'agent-other', name: 'other', displayName: 'Other', projectPath: '/p/other' },
      ],
      existingSchedules: [{ name: 'inbox-tick', agentId: null, enabled: false }],
    });

    const result = await applyShape('linear-ops', shared.deps);

    expect(result.applied.schedulesRebound).toEqual([]);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    expect(shared.createSchedule).not.toHaveBeenCalled();
    expect(shared.schedules).toEqual([{ name: 'inbox-tick', agentId: null, enabled: false }]);
  });

  it('(d) re-binds a startDisabled schedule to its agent but keeps it disabled', async () => {
    // A schedule declared startDisabled should move to its agent when the agent
    // appears (so it runs AS the agent when the user enables it), but the apply
    // must not enable it against the manifest's wish.
    const manifest = buildManifest({
      agents: [
        {
          ref: 'linear-tender',
          affinity: 'default',
          matchName: 'Linear Tender',
          template: { displayName: 'Linear Tender' },
        },
      ],
      schedules: [
        {
          name: 'inbox-tick',
          description: 'poll',
          prompt: 'go',
          cron: '*/15 * * * *',
          agentRef: 'linear-tender',
          permissionMode: 'acceptEdits',
          startDisabled: true,
        },
      ],
    });
    const shared = makeDeps({
      manifest,
      registeredAgents: [LINEAR_TENDER_AGENT],
      existingSchedules: [{ name: 'inbox-tick', agentId: null, enabled: false }],
    });

    const result = await applyShape('s', shared.deps);

    expect(result.applied.schedulesRebound).toEqual(['inbox-tick']);
    expect(shared.rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-tender',
      enabled: false,
    });
    // Bound to the agent, still disabled (its manifest wants it to start off).
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false },
    ]);
  });
});
