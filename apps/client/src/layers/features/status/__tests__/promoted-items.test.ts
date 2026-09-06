import { describe, it, expect } from 'vitest';
import { selectPromotedItems } from '../model/promoted-items';
import {
  STATUS_BAR_REGISTRY,
  type StatusBarItemKey,
  type StatusPromotionContext,
} from '../model/status-bar-registry';

/** A resting session: connected, default everything, nothing to report. */
function restingContext(overrides: Partial<StatusPromotionContext> = {}): StatusPromotionContext {
  return {
    cwd: '/work/repo',
    git: { dirty: false, onDefaultBranch: true },
    contextPercent: 12,
    connectionState: 'connected',
    permissionMode: 'default',
    permissionDescriptor: null,
    plan: null,
    runtime: { isDefault: true, canSelect: false },
    usage: { kind: 'pay-as-you-go', costUsd: 0.03 },
    subagentsInFlight: 0,
    ...overrides,
  };
}

/** A node for every registry key, so node availability never confounds a test. */
function allNodes(): Partial<Record<StatusBarItemKey, string>> {
  return Object.fromEntries(STATUS_BAR_REGISTRY.map((item) => [item.key, `node:${item.key}`]));
}

describe('selectPromotedItems', () => {
  it('returns only what promoted, in registry order', () => {
    const items = selectPromotedItems({ ctx: restingContext(), pins: [], nodes: allNodes() });
    expect(items.map((i) => i.key)).toEqual(['agent', 'cwd', 'model']);
  });

  it('carries each item’s cluster, resolved severity, and node', () => {
    const items = selectPromotedItems({
      ctx: restingContext({ contextPercent: 91 }),
      pins: [],
      nodes: allNodes(),
    });
    const context = items.find((i) => i.key === 'context')!;
    expect(context.cluster).toBe('right');
    expect(context.node).toBe('node:context');
    expect(context.severity).toBeGreaterThan(items.find((i) => i.key === 'model')!.severity);
  });

  it('skips an item with no node even when its rule fires', () => {
    // Nothing to draw is its own answer — the line never reserves space for data
    // that has not arrived.
    const nodes = allNodes();
    delete nodes.cwd;
    const items = selectPromotedItems({ ctx: restingContext(), pins: [], nodes });
    expect(items.map((i) => i.key)).toEqual(['agent', 'model']);
  });

  it('treats a null node the same as a missing one', () => {
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: [],
      nodes: { ...allNodes(), model: null },
    });
    expect(items.map((i) => i.key)).not.toContain('model');
  });
});

describe('selectPromotedItems — pins', () => {
  it('shows a pinned item whose rule would keep it quiet', () => {
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: ['usage'],
      nodes: allNodes(),
    });
    expect(items.map((i) => i.key)).toEqual(['agent', 'cwd', 'model', 'usage']);
    expect(items.find((i) => i.key === 'usage')!.pinned).toBe(true);
  });

  it('includes an item that both promoted and is pinned exactly once', () => {
    // `model` always promotes, so a pin on it changes nothing about its slot — but
    // the flag still reports the pin, which is what raises its priority in a budget.
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: ['model'],
      nodes: allNodes(),
    });
    expect(items.filter((i) => i.key === 'model')).toHaveLength(1);
    expect(items.find((i) => i.key === 'model')!.pinned).toBe(true);
  });

  it('keeps a pinned item’s place in registry order rather than appending it', () => {
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: ['git'],
      nodes: allNodes(),
    });
    expect(items.map((i) => i.key)).toEqual(['agent', 'cwd', 'git', 'model']);
  });

  it('refuses to honour a pin on a diagnostics row', () => {
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: ['connection', 'subagents'],
      nodes: allNodes(),
    });
    expect(items.map((i) => i.key)).toEqual(['agent', 'cwd', 'model']);
  });

  it('refuses to honour a pin on an item excluded from the line', () => {
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: ['cache', 'sound'],
      nodes: allNodes(),
    });
    expect(items.map((i) => i.key)).toEqual(['agent', 'cwd', 'model']);
  });

  it('ignores a pin for a key that no longer exists', () => {
    // Stale localStorage from a removed item is harmless.
    const items = selectPromotedItems({
      ctx: restingContext(),
      pins: ['clients', 'sync'],
      nodes: allNodes(),
    });
    expect(items.map((i) => i.key)).toEqual(['agent', 'cwd', 'model']);
  });

  it('leaves a pinned item exposed to a width budget, not exempt from it', () => {
    // A pin raises priority; it does not buy immunity. If pins bypassed the budget,
    // pinning five items would recreate the overflow this design removes — so the
    // pinned item lands in the same severity-ranked list as everything else.
    const items = selectPromotedItems({
      ctx: restingContext({ connectionState: 'disconnected' }),
      pins: ['usage'],
      nodes: allNodes(),
    });
    const right = items
      .filter((i) => i.cluster === 'right')
      .sort((a, b) => b.severity - a.severity);
    expect(right[0].key).toBe('connection');
    expect(right.map((i) => i.key)).toContain('usage');
  });
});

describe('selectPromotedItems — rigidity travels with the item', () => {
  it('marks the number-bearing items so the row knows not to squeeze them', () => {
    // The row draws what it is handed and decides nothing, so "this value is a
    // number" has to arrive as data (DOR-461 review).
    const items = selectPromotedItems({
      ctx: restingContext({
        contextPercent: 91,
        usage: { kind: 'subscription', utilization: 0.99, state: 'exhausted' },
        permissionMode: 'plan',
      }),
      pins: [],
      nodes: allNodes(),
    });
    const rigid = Object.fromEntries(items.map((i) => [i.key, i.rigid]));
    expect(rigid.context).toBe(true);
    expect(rigid.usage).toBe(true);
    expect(rigid.permission).toBe(false);
    expect(rigid.model).toBe(false);
  });
});

describe('selectPromotedItems — a degraded session', () => {
  it('promotes every signal that has something to say, ranked for a budget', () => {
    const items = selectPromotedItems({
      ctx: restingContext({
        connectionState: 'reconnecting',
        contextPercent: 78,
        permissionMode: 'plan',
        runtime: { isDefault: false, canSelect: false },
        git: { dirty: true, onDefaultBranch: false },
        subagentsInFlight: 3,
        usage: { kind: 'subscription', utilization: 0.95, state: 'exhausted' },
      }),
      pins: [],
      nodes: allNodes(),
    });

    expect(items.map((i) => i.key)).toEqual([
      'agent',
      'cwd',
      'git',
      'runtime',
      'model',
      'context',
      'usage',
      'permission',
      'subagents',
      'connection',
    ]);

    // What the budget keeps first when the bar cannot fit ten items: the two
    // things that are wrong, then the window filling up. Three running subagents
    // are news but not a problem, so they wait behind all of them (DOR-462).
    const byUrgency = items
      .filter((i) => i.cluster === 'right')
      .sort((a, b) => b.severity - a.severity)
      .map((i) => i.key);
    expect(byUrgency.slice(0, 3)).toEqual(['connection', 'usage', 'context']);
    expect(byUrgency.indexOf('subagents')).toBeGreaterThan(byUrgency.indexOf('usage'));
  });
});
