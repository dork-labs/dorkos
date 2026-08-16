/**
 * The status line's capability gates — the conditions that decide whether an
 * item is BUILT at all.
 *
 * `buildStatusItemNodes` is where a runtime's declared capabilities stop being
 * data and start being a UI: a key it does not set is an item
 * `selectPromotedItems` treats as an automatic no, so a wrong gate here is an
 * affordance that is dead rather than hidden. The cost gate is the one with a
 * real capability in it, and it had no test anywhere — which is how a browser
 * test asserting the absence of the cost item came to pass for the wrong reason
 * (the runtime it ran against reported no usage at all, so the first half of the
 * condition was false and the capability half was never reached).
 *
 * That is the shape this file exists to prevent: each case below pairs a
 * PRESENT, renderable usage with the flag, so the flag is the only thing that
 * differs between them.
 *
 * The blocks below the cost gate cover a second gate of the same shape
 * (DOR-1236): while a way of working (Plan) holds the session, the
 * permission-mode item has no trust stop to report, so `buildStatusItemNodes`
 * omits its node entirely rather than build one that says so. That omission
 * matters past the node map — `selectPromotedItems` skips a key with no node
 * BEFORE it ever reaches the promotion rule (`hasContent`, `promoted-items.ts`),
 * so an item built-but-empty here would still contest a right-cluster budget
 * slot and could starve the item that IS news, the composer's Plan switch. The
 * seam-level tests build the real promoted list via `selectPromotedItems` +
 * `applyStatusBudget` to prove the slot is actually freed, not merely that the
 * node key is absent in isolation.
 *
 * @module features/chat/ui/status/__tests__/status-item-nodes
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ConnectionState, UsageStatus } from '@dorkos/shared/types';
import type { PermissionModeDescriptor, RuntimeCapabilities } from '@dorkos/shared/agent-runtime';
import {
  selectPromotedItems,
  applyStatusBudget,
  resolveStatusBudget,
  type StatusPromotionContext,
} from '@/layers/features/status';
import { TooltipProvider } from '@/layers/shared/ui';
import { buildStatusItemNodes, type StatusItemNodesInput } from '../status-item-nodes';

// The permission-mode item resolves the runtime's declared modes through this
// hook; stub only that export so the one render-based test below drives the
// real component. `importOriginal` keeps every OTHER export (e.g.
// `formatModelLabel`) intact — a whole-module replacement silently drops them,
// which breaks any node this file builds but never asserts on directly.
const mockCapabilitiesForRuntime = vi.fn<
  (runtimeType: string | null | undefined) => RuntimeCapabilities | undefined
>(() => undefined);

vi.mock('@/layers/entities/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/runtime')>();
  return {
    ...actual,
    useCapabilitiesForRuntime: (runtimeType: string | null | undefined) =>
      mockCapabilitiesForRuntime(runtimeType),
  };
});

/**
 * A usage a runtime really reported, and one {@link hasRenderableUsage} says
 * yes to.
 *
 * `pay-as-you-go` with a cost is the least ambiguous renderable shape: the
 * predicate reduces to `costUsd != null`, so nothing about WHICH branch of the
 * predicate ran can be confused with the capability gate under test.
 */
const RENDERABLE_USAGE: UsageStatus = { kind: 'pay-as-you-go', costUsd: 0.42 };

/**
 * Everything the builder needs, with the two fields each test varies left to the
 * caller.
 *
 * Written out rather than imported from the dev playground's showcase data: that
 * fixture exists to be edited freely for visual demos, and a gate test whose
 * inputs move for cosmetic reasons is a gate test that will one day pass for a
 * reason nobody chose.
 *
 * @param overrides - The fields under test.
 */
function inputWith(overrides: Partial<StatusItemNodesInput>): StatusItemNodesInput {
  return {
    sessionId: 'ses-1',
    agent: { name: 'Ana', path: '/tmp/ana' },
    status: {
      permissionMode: 'default',
      model: 'claude-sonnet-4-5',
      effort: null,
      fastMode: false,
      costUsd: null,
      contextPercent: null,
      isStreaming: false,
      cwd: '/tmp/ana',
    },
    onUpdateSession: vi.fn(),
    onChangeMode: vi.fn(),
    modelSupportsAutoMode: false,
    makeDefault: null,
    onPermissionPickerOpenChange: vi.fn(),
    plan: null,
    gitStatus: undefined,
    workspace: null,
    runtimeChip: { runtime: 'test-mode', model: null, canSelect: false, onChangeRuntime: vi.fn() },
    contextPercent: null,
    contextUsage: null,
    compact: null,
    usage: null,
    supportsCostTracking: false,
    runningSubagents: [],
    liveSubagentCount: 0,
    waitingOnSubagents: false,
    connectionState: 'connected',
    density: 'full',
    ...overrides,
  };
}

describe('buildStatusItemNodes — the cost gate', () => {
  it('builds the usage item for a runtime that declares it can track cost', () => {
    const nodes = buildStatusItemNodes(
      inputWith({ usage: RENDERABLE_USAGE, supportsCostTracking: true })
    );

    // The control. Without it the two cases below cannot be told apart from a
    // builder that never draws usage at all.
    expect(nodes.usage).toBeDefined();
  });

  it('draws NO cost for a runtime that declares it cannot track it, even with usage in hand', () => {
    const nodes = buildStatusItemNodes(
      inputWith({ usage: RENDERABLE_USAGE, supportsCostTracking: false })
    );

    // The claim `supportsCostTracking` exists to make: a runtime that says it
    // cannot track cost must never show a cost figure — not a zero, not an empty
    // item. The usage is present and renderable, so the flag is the only reason
    // this key is absent.
    expect(nodes.usage).toBeUndefined();
  });

  it('draws no cost when there is no usage, whatever the runtime declares', () => {
    // The other half of the conjunction, pinned so a future simplification that
    // dropped `hasRenderableUsage` and kept only the flag would be caught here
    // rather than by an empty item shipping.
    expect(
      buildStatusItemNodes(inputWith({ usage: null, supportsCostTracking: true })).usage
    ).toBeUndefined();
    expect(
      buildStatusItemNodes({
        ...inputWith({ supportsCostTracking: true }),
        // Renderable-usage's own falsehood: a subscription with neither
        // utilization nor cost has nothing to say.
        usage: { kind: 'subscription' },
      }).usage
    ).toBeUndefined();
  });
});

/**
 * Claude's own declaration of Plan (mirrors `runtime-constants.ts`): the working
 * mode both the permission item and the composer's Plan switch resolve from.
 */
const PLAN_DESCRIPTOR: PermissionModeDescriptor = {
  id: 'plan',
  label: 'Plan',
  description: 'Read-only planning mode — the agent cannot execute tools.',
  stop: 'ask',
  axis: 'working',
  asks: 'always',
  reach: 'read',
  promise: 'Reads and plans only. Nothing changes until you approve the plan.',
};

/** A minimal claude-code profile carrying {@link PLAN_DESCRIPTOR} among its modes. */
const CLAUDE_CAPABILITIES: RuntimeCapabilities = {
  type: 'claude-code',
  supportsToolApproval: true,
  supportsCostTracking: true,
  supportsResume: true,
  supportsMcp: true,
  supportsManagedMcpServers: true,
  supportsQuestionPrompt: true,
  supportsPlugins: true,
  supportsPersistentSession: false,
  supportsSteer: false,
  supportsContextStaging: false,
  nativeContext: [],
  permissionModes: {
    supported: true,
    default: 'default',
    values: [
      {
        id: 'default',
        label: 'Default',
        stop: 'ask',
        asks: 'always',
        reach: 'edit',
        promise: 'Asks before it edits a file or runs a command.',
      },
      {
        id: 'acceptEdits',
        label: 'Accept edits',
        stop: 'act',
        asks: 'when-risky',
        reach: 'edit',
        promise: 'Edits files on its own. Asks before it runs a command.',
      },
      PLAN_DESCRIPTOR,
      {
        id: 'bypassPermissions',
        label: 'Bypass permissions',
        stop: 'autonomy',
        asks: 'never',
        reach: 'everything',
        promise: 'Runs everything without asking, including outside this project.',
      },
    ],
  },
  commandIntents: { compact: { supported: false } },
  settings: { configSection: null, supportsEffort: false, sections: [] },
  features: {},
};

describe('buildStatusItemNodes — the permission node while Plan holds the session', () => {
  it('omits the permission node and keeps the plan node, while the session is planning', () => {
    const nodes = buildStatusItemNodes(
      inputWith({
        status: { ...inputWith({}).status, permissionMode: 'plan' },
        runtimeChip: {
          runtime: 'claude-code',
          model: null,
          canSelect: false,
          onChangeRuntime: vi.fn(),
        },
        plan: { descriptor: PLAN_DESCRIPTOR, active: true, onToggle: vi.fn() },
      })
    );

    expect(nodes.permission).toBeUndefined();
    expect(nodes.plan).toBeDefined();
  });

  it('fills the permission node normally when Plan is offered but not active', () => {
    // The control for the case above: a runtime that declares a working mode is
    // not, by itself, the reason the node disappears. Only `active` is.
    const nodes = buildStatusItemNodes(
      inputWith({
        status: { ...inputWith({}).status, permissionMode: 'acceptEdits' },
        runtimeChip: {
          runtime: 'claude-code',
          model: null,
          canSelect: false,
          onChangeRuntime: vi.fn(),
        },
        plan: { descriptor: PLAN_DESCRIPTOR, active: false, onToggle: vi.fn() },
      })
    );

    expect(nodes.permission).toBeDefined();
    expect(nodes.plan).toBeDefined();
  });
});

/** What one scenario varies: whether Plan holds the session, and the rest of the bar's state. */
interface LineScenario {
  planActive: boolean;
  connectionState?: ConnectionState;
  contextPercent?: number | null;
  /**
   * The session's permission mode when Plan is NOT holding it. Defaults to
   * `'default'`, which the registry never promotes (`ctx.permissionMode !==
   * 'default'`) — irrelevant while Plan is active (the node is omitted before
   * that rule is ever reached), but load-bearing for a control case that wants
   * to see the permission chip promote normally.
   */
  inactivePermissionMode?: 'default' | 'acceptEdits';
}

/**
 * Build the line the way `ChatStatusSection` actually does: resolve the width's
 * budget first (so `density` threads into the nodes exactly as production wires
 * it), build the nodes, then run the real `selectPromotedItems` +
 * `applyStatusBudget` pipeline. Crossing this seam is what proves the freed
 * slot actually reaches `plan` — a check on `nodes.permission` alone cannot see
 * `applyStatusBudget`'s tie-break, which is where DOR-1236 actually lived.
 *
 * @param width - Measured bar width in CSS pixels, fed to `resolveStatusBudget`.
 * @param scenario - Whether Plan is active, and the rest of the promotion state.
 */
function buildLine(
  width: number,
  {
    planActive,
    connectionState = 'connected',
    contextPercent = null,
    inactivePermissionMode = 'default',
  }: LineScenario
) {
  const permissionMode = planActive ? 'plan' : inactivePermissionMode;
  const budget = resolveStatusBudget(width);
  const plan = { descriptor: PLAN_DESCRIPTOR, active: planActive, onToggle: vi.fn() };
  const nodes = buildStatusItemNodes(
    inputWith({
      status: {
        permissionMode,
        model: 'claude-sonnet-4-5',
        effort: null,
        fastMode: false,
        costUsd: null,
        contextPercent,
        isStreaming: false,
        cwd: '/tmp/ana',
      },
      runtimeChip: {
        runtime: 'claude-code',
        model: null,
        canSelect: false,
        onChangeRuntime: vi.fn(),
      },
      plan,
      contextPercent,
      connectionState,
      density: budget.density,
    })
  );
  const ctx: StatusPromotionContext = {
    cwd: '/tmp/ana',
    git: null,
    contextPercent,
    connectionState,
    permissionMode,
    permissionDescriptor: planActive
      ? PLAN_DESCRIPTOR
      : (CLAUDE_CAPABILITIES.permissionModes.values.find((d) => d.id === permissionMode) ?? null),
    plan: { active: planActive },
    runtime: null,
    usage: null,
    subagentsInFlight: 0,
  };
  return applyStatusBudget(selectPromotedItems({ ctx, pins: [], nodes }), budget);
}

describe('buildStatusItemNodes → selectPromotedItems → applyStatusBudget (DOR-1236)', () => {
  it('gives Plan the slot, not an empty permission chip, for a healthy planning session at a comfortable width', () => {
    const { items } = buildLine(800, { planActive: true });
    const keys = items.map((item) => item.key);

    expect(keys).toContain('plan');
    expect(keys).not.toContain('permission');
  });

  // The three narrow-tier floors from `resolveStatusBudget` (`compact`,
  // `compact`, `identity` respectively) — every one of them gives the right
  // cluster only 3 slots, so all three actually exercise the contested budget
  // rather than restating one width three times.
  for (const width of [600, 460, 380]) {
    it(`frees the slot Plan needs under the degraded session — reconnecting, 92% context — at width=${width}`, () => {
      const { items } = buildLine(width, {
        planActive: true,
        connectionState: 'reconnecting',
        contextPercent: 92,
      });
      const keys = items.map((item) => item.key);

      // Before the fix: `permission` and `plan` tie at severity 40
      // (PERMISSION_ELEVATED / PLAN_ACTIVE), the stable sort in
      // `applyStatusBudget` breaks the tie by registry order, and `permission`
      // is listed first — so a built-but-empty permission node would win this
      // contested slot and `plan` would land under the `⋯`.
      expect(keys).toContain('plan');
      expect(keys).not.toContain('permission');
    });
  }

  it('still promotes the permission chip normally at the same width once Plan is off', () => {
    // The control: the width, the connection state, and the context percent are
    // unchanged from the case above — only `planActive` flips (and the mode it
    // left, since 'default' never promotes on its own) — so a fix that hid the
    // item unconditionally, rather than only while Plan holds the dial, would be
    // caught here.
    const { items } = buildLine(460, {
      planActive: false,
      connectionState: 'reconnecting',
      contextPercent: 92,
      inactivePermissionMode: 'acceptEdits',
    });
    const keys = items.map((item) => item.key);

    expect(keys).toContain('permission');
  });
});

describe('PermissionModeItem vs. PlanModeItem — never the same word when both are visible', () => {
  afterEach(() => {
    cleanup();
    mockCapabilitiesForRuntime.mockReset();
  });

  it('renders distinct visible text and accessible names when Plan is offered but not holding the session', () => {
    // Still true trivially now that the frozen state omits the permission node
    // entirely (DOR-1236) — kept as the regression pin: if a future change
    // reintroduces a permission chip while both items are visible, this is what
    // would catch two controls saying the same word again.
    mockCapabilitiesForRuntime.mockReturnValue(CLAUDE_CAPABILITIES);
    const nodes = buildStatusItemNodes(
      inputWith({
        status: {
          permissionMode: 'acceptEdits',
          model: 'claude-sonnet-4-5',
          effort: null,
          fastMode: false,
          costUsd: null,
          contextPercent: null,
          isStreaming: false,
          cwd: '/tmp/ana',
        },
        runtimeChip: {
          runtime: 'claude-code',
          model: null,
          canSelect: false,
          onChangeRuntime: vi.fn(),
        },
        plan: { descriptor: PLAN_DESCRIPTOR, active: false, onToggle: vi.fn() },
      })
    );

    // Without both keys present, the assertions below would pass by finding
    // nothing to compare.
    expect(nodes.permission).toBeDefined();
    expect(nodes.plan).toBeDefined();

    render(
      <TooltipProvider>
        {nodes.permission}
        {nodes.plan}
      </TooltipProvider>
    );

    const buttons = screen.getAllByRole('button');
    const visibleTexts = buttons.map((button) => button.textContent);
    expect(new Set(visibleTexts).size).toBe(visibleTexts.length);
    expect(screen.getByRole('button', { name: 'Plan' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Permissions: Accept edits' })).toBeInTheDocument();
  });
});
