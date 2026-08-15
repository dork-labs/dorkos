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
 * @module features/chat/ui/status/__tests__/status-item-nodes
 */
import { describe, it, expect, vi } from 'vitest';
import type { UsageStatus } from '@dorkos/shared/types';
import { buildStatusItemNodes, type StatusItemNodesInput } from '../status-item-nodes';

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
