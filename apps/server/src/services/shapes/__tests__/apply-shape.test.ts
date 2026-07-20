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
import { slugify } from '@dorkos/skills/slug';
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
  /** The provenance marker: the creating Shape's name, or `null` = user-created. */
  shapeOrigin: string | null;
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
  /** The currently-active Shape name — the swap turns off its extensions. */
  activeShape?: string;
  /**
   * Manifests resolvable by name besides the applied one (e.g. the outgoing
   * Shape). An explicit `null` models a no-longer-installed Shape.
   */
  otherManifests?: Record<string, ShapePackageManifest | null>;
}) {
  const present = new Set(opts.presentExtensions ?? []);
  const enablable = new Set(opts.enablableExtensions ?? opts.presentExtensions ?? []);
  const setSecrets = new Set((opts.setSecrets ?? []).map(([e, k]) => `${e}:${k}`));
  // The fake store, keyed by name (the real service's cross-scope identity).
  const schedules: FakeSchedule[] = (opts.existingSchedules ?? []).map((s) => ({ ...s }));

  const createSchedule = vi.fn(async (req: CreateTaskRequest, origin?: { shape: string }) => {
    // Mirror production: the real service stores each schedule under
    // `slugify(req.name)` and upserts by file path (slug + scope), so a manifest
    // that declares "Inbox Tick" lands as "inbox-tick" and re-creating it is
    // idempotent rather than a duplicate.
    const name = slugify(req.name);
    const agentId = req.target === 'global' ? null : req.target;
    const entry: FakeSchedule = {
      name,
      agentId,
      enabled: req.enabled ?? true,
      shapeOrigin: origin?.shape ?? null,
    };
    const existing = schedules.find((s) => s.name === name && s.agentId === agentId);
    if (existing) Object.assign(existing, entry);
    else schedules.push(entry);
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
  // Provenance-gated deletion, mirroring the real service: remove every schedule
  // stamped with `shapeName` whose name is not spared by `keepNames`.
  const deleteSchedulesForShape = vi.fn(
    async (shapeName: string, keepNames?: ReadonlySet<string>) => {
      const removed: string[] = [];
      for (let i = schedules.length - 1; i >= 0; i--) {
        const s = schedules[i];
        if (keepNames?.has(s.name)) continue;
        if (s.shapeOrigin !== shapeName) continue;
        schedules.splice(i, 1);
        removed.push(s.name);
      }
      return removed;
    }
  );
  const enable = vi.fn(async (id: string) => (enablable.has(id) ? { reloadRequired: true } : null));
  const disable = vi.fn(async () => undefined);
  const setActiveShape = vi.fn();

  const deps: ApplyShapeDeps = {
    // Name-aware: the applied Shape resolves to `opts.manifest`; the outgoing
    // Shape (and any other) resolves from `opts.otherManifests`.
    manifestResolver: {
      resolve: vi.fn(async (queryName: string) =>
        opts.otherManifests && queryName in opts.otherManifests
          ? opts.otherManifests[queryName]
          : opts.manifest
      ),
    },
    extensionManager: {
      get: (id) => (present.has(id) ? { manifest: { serverCapabilities: {} } } : undefined),
      enable,
      disable,
    },
    secretChecker: { isSet: async (ext, key) => setSecrets.has(`${ext}:${key}`) },
    agentRegistry: { listWithPaths: () => opts.registeredAgents ?? [] },
    scheduleService: {
      // Existence is by NAME across every scope; `agentId` distinguishes a
      // still-waiting global copy (re-bindable) from an already-bound one.
      listSchedules: () => schedules.map((s) => ({ ...s })),
      createSchedule,
      rebindSchedule,
      deleteSchedulesForShape,
    },
    configStore: {
      getShapePrefs: () => ({
        active: opts.activeShape ?? null,
        agentDefaults: {},
        autoFollowAgent: opts.autoFollowAgent ?? false,
      }),
      setActiveShape,
    },
  };
  return {
    deps,
    createSchedule,
    rebindSchedule,
    deleteSchedulesForShape,
    enable,
    disable,
    setActiveShape,
    schedules,
  };
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
    // Created carrying the Shape's provenance marker.
    expect(shared.createSchedule.mock.calls[0][1]).toEqual({ shape: 'linear-ops' });
    // It landed global + disabled (waiting on its agent), stamped as Shape-owned.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'linear-ops' },
    ]);

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
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: 'linear-ops' },
    ]);
    // And no repeat of the created-disabled warning for a schedule that was not created.
    expect(second.warnings).not.toContain(
      "Schedule 'inbox-tick' created disabled — agent 'linear-tender' missing"
    );
  });

  it('(c) re-binds a NON-KEBAB schedule name across the global→agent flip (slug-lookup regression)', async () => {
    // GAP-5 regression: the manifest declares "Inbox Tick" but schedules are
    // STORED under their slug "inbox-tick". The existence check keyed the map by
    // the stored slug yet looked it up by the raw manifest name, so a non-kebab
    // name always missed its earlier copy: the documented global→agent flip
    // silently never fired, and a disabled global copy lingered (reconciliation
    // spares it — its slug is in the kept set). Both the lookup and the re-bind
    // call must key off the slug.
    const manifest = buildManifest({
      name: 'linear-ops',
      agents: [
        {
          ref: 'tender',
          affinity: 'default',
          matchName: 'Tender',
          template: { displayName: 'Tender' },
        },
      ],
      schedules: [
        {
          name: 'Inbox Tick',
          description: 'poll',
          prompt: 'go',
          cron: '*/15 * * * *',
          agentRef: 'tender',
          permissionMode: 'acceptEdits',
        },
      ],
    });
    const agent: RegisteredAgentView = {
      id: 'agent-tender',
      name: 'tender',
      displayName: 'Tender',
      projectPath: '/p/tender',
    };
    // The agent is absent on the first apply, then created before the reapply.
    const registeredAgents: RegisteredAgentView[] = [];
    const shared = makeDeps({ manifest, registeredAgents });

    // First apply: no agent yet → the schedule lands global + disabled, stored
    // under its slug, stamped as Shape-owned.
    const first = await applyShape('linear-ops', shared.deps);
    expect(first.applied.schedulesCreated).toEqual(['Inbox Tick']);
    expect(first.applied.schedulesRebound).toEqual([]);
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'linear-ops' },
    ]);

    // The offered agent appears, then the Shape is re-applied.
    registeredAgents.push(agent);
    const second = await applyShape('linear-ops', shared.deps);

    // The flip fires: re-bound (not re-created), keyed by the STORED slug.
    expect(second.applied.schedulesCreated).toEqual([]);
    expect(second.applied.schedulesRebound).toEqual(['Inbox Tick']);
    expect(shared.createSchedule).toHaveBeenCalledTimes(1);
    expect(shared.rebindSchedule).toHaveBeenCalledTimes(1);
    expect(shared.rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-tender',
      enabled: true,
    });
    // Exactly one schedule — agent-bound + enabled. No lingering disabled global copy.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: 'linear-ops' },
    ]);
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
      existingSchedules: [
        { name: 'inbox-tick', agentId: 'agent-tender', enabled: false, shapeOrigin: null },
      ],
    });

    const result = await applyShape('linear-ops', shared.deps);

    expect(result.applied.schedulesCreated).toEqual([]);
    expect(result.applied.schedulesRebound).toEqual([]);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    expect(shared.createSchedule).not.toHaveBeenCalled();
    // Left exactly as the user set it — still bound, still disabled.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false, shapeOrigin: null },
    ]);
  });

  it('(d) never touches a user-created global schedule that collides with a Shape schedule name', async () => {
    // THE ADVERSARIAL CASE: the user created their own global schedule named
    // 'inbox-tick' via the tasks API — no Shape provenance marker. The Shape's
    // agent then appears and the Shape is re-applied. Name + unbound alone
    // must NOT be treated as ownership: the user's schedule stays exactly
    // where and how they made it (not re-homed, not enabled, not disabled).
    const shared = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [LINEAR_TENDER_AGENT],
      existingSchedules: [{ name: 'inbox-tick', agentId: null, enabled: true, shapeOrigin: null }],
    });

    const result = await applyShape('linear-ops', shared.deps);

    expect(result.applied.schedulesCreated).toEqual([]);
    expect(result.applied.schedulesRebound).toEqual([]);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    expect(shared.createSchedule).not.toHaveBeenCalled();
    // The user's schedule is untouched.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: true, shapeOrigin: null },
    ]);
  });

  it("(d) never re-binds another Shape's waiting schedule, even on a name collision", async () => {
    // A different Shape created (and still owns) the waiting global schedule.
    // Applying THIS Shape must not steal it.
    const shared = makeDeps({
      manifest: linearOpsManifest(),
      presentExtensions: ['linear-issues'],
      setSecrets: [['linear-issues', 'linear_api_key']],
      registeredAgents: [LINEAR_TENDER_AGENT],
      existingSchedules: [
        { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'other-shape' },
      ],
    });

    const result = await applyShape('linear-ops', shared.deps);

    expect(result.applied.schedulesRebound).toEqual([]);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'other-shape' },
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
      existingSchedules: [
        { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'linear-ops' },
      ],
    });

    const result = await applyShape('linear-ops', shared.deps);

    expect(result.applied.schedulesRebound).toEqual([]);
    expect(shared.rebindSchedule).not.toHaveBeenCalled();
    expect(shared.createSchedule).not.toHaveBeenCalled();
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 'linear-ops' },
    ]);
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
      existingSchedules: [{ name: 'inbox-tick', agentId: null, enabled: false, shapeOrigin: 's' }],
    });

    const result = await applyShape('s', shared.deps);

    expect(result.applied.schedulesRebound).toEqual(['inbox-tick']);
    expect(shared.rebindSchedule).toHaveBeenCalledWith('inbox-tick', {
      agentId: 'agent-tender',
      enabled: false,
    });
    // Bound to the agent, still disabled (its manifest wants it to start off).
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: false, shapeOrigin: 's' },
    ]);
  });

  // ── Offer schedule summary (M1 arrival ledger) ─────────────────────────────

  it('derives a human scheduleSummary for an offered agent from its bound schedule', async () => {
    const manifest = buildManifest({
      agents: [{ ref: 'keeper', affinity: 'default', template: { displayName: 'Keeper' } }],
      schedules: [
        {
          name: 'morning-triage',
          description: 'triage the board',
          prompt: 'triage',
          cron: '0 9 * * 1-5',
          agentRef: 'keeper',
          permissionMode: 'acceptEdits',
        },
      ],
    });
    const { deps } = makeDeps({ manifest });

    const result = await applyShape('s', deps);

    expect(result.offeredAgents[0].scheduleSummary).toBe('Every weekday at 9:00 AM');
  });

  it('appends a declared timezone so the time never reads as the local hour', async () => {
    const manifest = buildManifest({
      agents: [{ ref: 'keeper', affinity: 'default', template: { displayName: 'Keeper' } }],
      schedules: [
        {
          name: 'morning-triage',
          description: 'triage the board',
          prompt: 'triage',
          cron: '0 9 * * 1-5',
          timezone: 'America/New_York',
          agentRef: 'keeper',
          permissionMode: 'acceptEdits',
        },
      ],
    });
    const { deps } = makeDeps({ manifest });

    const result = await applyShape('s', deps);

    expect(result.offeredAgents[0].scheduleSummary).toBe(
      'Every weekday at 9:00 AM (America/New_York)'
    );
  });

  it('omits scheduleSummary when the cron is not describable — never leaks raw cron', async () => {
    const manifest = buildManifest({
      agents: [{ ref: 'keeper', affinity: 'default', template: { displayName: 'Keeper' } }],
      schedules: [
        {
          name: 'tick',
          description: 'poll',
          prompt: 'tick',
          cron: '*/15 * * * *',
          agentRef: 'keeper',
          permissionMode: 'acceptEdits',
        },
      ],
    });
    const { deps } = makeDeps({ manifest });

    const result = await applyShape('s', deps);

    expect(result.offeredAgents[0].scheduleSummary).toBeUndefined();
  });

  it('omits scheduleSummary when the Shape declares no schedule for the agent', async () => {
    const manifest = buildManifest({
      agents: [{ ref: 'keeper', affinity: 'default', template: { displayName: 'Keeper' } }],
    });
    const { deps } = makeDeps({ manifest });

    const result = await applyShape('s', deps);

    expect(result.offeredAgents[0].scheduleSummary).toBeUndefined();
  });

  // === (e) Extension swap on Shape switch ===

  it('(e) switching A→B disables A-only extensions, keeps the overlap, enables B', async () => {
    // Shape A is active; applying Shape B must turn OFF A's extensions that B
    // does not also declare, leave the shared one enabled (no disable/enable
    // flap), and turn ON B's own. This is the swap that stops Shapes from piling
    // their extensions on.
    const shapeA = buildManifest({ name: 'shape-a', activates: ['ext-shared', 'ext-a-only'] });
    const shapeB = buildManifest({ name: 'shape-b', activates: ['ext-shared', 'ext-b-only'] });
    const { deps, disable, enable } = makeDeps({
      manifest: shapeB,
      presentExtensions: ['ext-shared', 'ext-b-only'],
      activeShape: 'shape-a',
      otherManifests: { 'shape-a': shapeA },
    });

    const result = await applyShape('shape-b', deps);

    // The overlap stays enabled — never disabled.
    expect(disable).not.toHaveBeenCalledWith('ext-shared');
    // A's exclusive extension is turned off, and reported.
    expect(disable).toHaveBeenCalledWith('ext-a-only');
    expect(disable).toHaveBeenCalledTimes(1);
    expect(result.applied.deactivatedExtensions).toEqual(['ext-a-only']);
    // B's full set is enabled (the overlap is enabled once, not flapped).
    expect(enable).toHaveBeenCalledWith('ext-shared');
    expect(enable).toHaveBeenCalledWith('ext-b-only');
    expect(result.applied.activatedExtensions).toEqual(['ext-shared', 'ext-b-only']);
  });

  it('(e) re-applying the SAME active Shape disables nothing', async () => {
    const shape = buildManifest({ name: 'shape-a', activates: ['ext-a'] });
    const { deps, disable } = makeDeps({
      manifest: shape,
      presentExtensions: ['ext-a'],
      activeShape: 'shape-a',
      otherManifests: { 'shape-a': shape },
    });

    const result = await applyShape('shape-a', deps);

    expect(disable).not.toHaveBeenCalled();
    expect(result.applied.deactivatedExtensions).toEqual([]);
  });

  it('(e) leaves extensions alone when the outgoing Shape is no longer installed', async () => {
    // The active pointer names a Shape whose manifest no longer resolves; its
    // declared set is unknown, so nothing is disabled (never guess).
    const shapeB = buildManifest({ name: 'shape-b', activates: ['ext-b'] });
    const { deps, disable } = makeDeps({
      manifest: shapeB,
      presentExtensions: ['ext-b'],
      activeShape: 'ghost-shape',
      otherManifests: { 'ghost-shape': null },
    });

    const result = await applyShape('shape-b', deps);

    expect(disable).not.toHaveBeenCalled();
    expect(result.applied.deactivatedExtensions).toEqual([]);
  });

  // === (f) Reconciliation: drop schedules the current version no longer declares ===

  it('(f) deletes a schedule an earlier version created but the current manifest dropped', async () => {
    // v1 stood up `old-tick` (still on disk, this Shape's provenance). v2's
    // manifest declares only `new-tick`. Applying v2 creates `new-tick` and
    // reconciles `old-tick` away — no stale schedule lingers.
    const v2 = buildManifest({
      name: 'linear-ops',
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
          name: 'new-tick',
          description: 'poll',
          prompt: 'go',
          cron: '*/15 * * * *',
          agentRef: 'linear-tender',
          permissionMode: 'acceptEdits',
        },
      ],
    });
    const { deps, deleteSchedulesForShape, schedules } = makeDeps({
      manifest: v2,
      registeredAgents: [LINEAR_TENDER_AGENT],
      // The dropped v1 schedule, agent-bound, still carrying this Shape's marker.
      existingSchedules: [
        { name: 'old-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: 'linear-ops' },
      ],
    });

    const result = await applyShape('linear-ops', deps);

    // The current schedule was created; the dropped one was reconciled away.
    expect(result.applied.schedulesCreated).toEqual(['new-tick']);
    expect(result.applied.schedulesRemoved).toEqual(['old-tick']);
    // Reconciliation spared the just-declared name.
    expect(deleteSchedulesForShape).toHaveBeenCalledWith('linear-ops', new Set(['new-tick']));
    // Exactly the new schedule remains; the stale one is gone.
    expect(schedules).toEqual([
      { name: 'new-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: 'linear-ops' },
    ]);
  });

  it("(f) reconciliation never deletes a user's or another Shape's colliding schedule", async () => {
    // Two schedules share nothing with this Shape's provenance: one user-created
    // (no marker), one owned by another Shape. Applying this Shape must not sweep
    // either, even though it drops all of its OWN schedules (declares none).
    const shape = buildManifest({ name: 'linear-ops', schedules: [] });
    const { deps, schedules } = makeDeps({
      manifest: shape,
      existingSchedules: [
        { name: 'user-tick', agentId: null, enabled: true, shapeOrigin: null },
        { name: 'other-tick', agentId: null, enabled: true, shapeOrigin: 'other-shape' },
        { name: 'mine-tick', agentId: null, enabled: true, shapeOrigin: 'linear-ops' },
      ],
    });

    const result = await applyShape('linear-ops', deps);

    // Only this Shape's own orphan is removed.
    expect(result.applied.schedulesRemoved).toEqual(['mine-tick']);
    expect(schedules).toEqual([
      { name: 'user-tick', agentId: null, enabled: true, shapeOrigin: null },
      { name: 'other-tick', agentId: null, enabled: true, shapeOrigin: 'other-shape' },
    ]);
  });

  it('(f) reconciliation keeps a schedule whose manifest name is not already kebab-case', async () => {
    // C1 regression: the manifest declares "Inbox Tick" but the schedule is
    // stored under its slug "inbox-tick". The reconciliation set must be built
    // from slugs, or the sweep deletes the very schedule this apply just created
    // — on every apply. Assert it is created once and survives, and that a
    // reapply keeps exactly one (never deleted, never duplicated).
    const manifest = buildManifest({
      name: 'linear-ops',
      agents: [
        {
          ref: 'tender',
          affinity: 'default',
          matchName: 'Tender',
          template: { displayName: 'Tender' },
        },
      ],
      schedules: [
        {
          name: 'Inbox Tick',
          description: 'poll',
          prompt: 'go',
          cron: '*/15 * * * *',
          agentRef: 'tender',
          permissionMode: 'acceptEdits',
        },
      ],
    });
    const agent: RegisteredAgentView = {
      id: 'agent-tender',
      name: 'tender',
      displayName: 'Tender',
      projectPath: '/p/tender',
    };
    const shared = makeDeps({ manifest, registeredAgents: [agent] });

    const first = await applyShape('linear-ops', shared.deps);

    // Created (reported under its manifest name) and NOT swept away.
    expect(first.applied.schedulesCreated).toEqual(['Inbox Tick']);
    expect(first.applied.schedulesRemoved).toEqual([]);
    // Stored under its slug, bound + enabled.
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: 'linear-ops' },
    ]);

    // Reapply keeps exactly one — reconciliation never deletes it, and the
    // idempotent create never duplicates it.
    const second = await applyShape('linear-ops', shared.deps);
    expect(second.applied.schedulesRemoved).toEqual([]);
    expect(shared.schedules).toEqual([
      { name: 'inbox-tick', agentId: 'agent-tender', enabled: true, shapeOrigin: 'linear-ops' },
    ]);
  });
});
