import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { PromoDefinition, PromoContext, PromoPlacement } from '../model/promo-types';

/** Minimal stub that satisfies the LucideIcon (ForwardRefExoticComponent) shape for tests. */
const StubIcon = forwardRef<SVGSVGElement>(() => null) as unknown as LucideIcon;

// Mock the promo registry
const mockRegistry: PromoDefinition[] = [];
vi.mock('../model/promo-registry', () => ({
  get PROMO_REGISTRY() {
    return mockRegistry;
  },
}));

// Mock the promo context
let mockContext: PromoContext = {
  hasAdapter: () => false,
  isTasksEnabled: false,
  isMeshEnabled: false,
  isRelayEnabled: false,
  sessionCount: 0,
  agentCount: 0,
  taskCount: 0,
  daysSinceFirstUse: 0,
};
vi.mock('../model/use-promo-context', () => ({
  usePromoContext: () => mockContext,
}));

// Mock app store
let mockDismissedIds: string[] = [];
let mockPromoEnabled = true;
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      dismissedPromoIds: mockDismissedIds,
      promoEnabled: mockPromoEnabled,
    }),
}));

import { usePromoSlot } from '../model/use-promo-slot';

function makePromo(overrides: Partial<PromoDefinition> & { id: string }): PromoDefinition {
  return {
    placements: ['dashboard-sidebar'],
    priority: 50,
    shouldShow: () => true,
    content: {
      icon: StubIcon,
      title: 'Test',
      shortDescription: 'Test promo',
      ctaLabel: 'Learn more',
    },
    action: { type: 'action', handler: () => {} },
    ...overrides,
  };
}

describe('usePromoSlot', () => {
  beforeEach(() => {
    mockRegistry.length = 0;
    mockDismissedIds = [];
    mockPromoEnabled = true;
    mockContext = {
      hasAdapter: () => false,
      isTasksEnabled: false,
      isMeshEnabled: false,
      isRelayEnabled: false,
      sessionCount: 0,
      agentCount: 0,
      taskCount: 0,
      daysSinceFirstUse: 0,
    };
  });

  it('filters promos by placement correctly', () => {
    mockRegistry.push(
      makePromo({ id: 'a', placements: ['dashboard-sidebar'] }),
      makePromo({ id: 'b', placements: ['agent-sidebar'] }),
      makePromo({ id: 'c', placements: ['dashboard-sidebar', 'agent-sidebar'] })
    );
    const { result } = renderHook(() => usePromoSlot('dashboard-sidebar', 10));
    expect(result.current.map((p) => p.id)).toEqual(['a', 'c']);
  });

  it('excludes dismissed promos from results', () => {
    mockRegistry.push(makePromo({ id: 'a' }), makePromo({ id: 'b' }));
    mockDismissedIds = ['a'];
    const { result } = renderHook(() => usePromoSlot('dashboard-sidebar', 10));
    expect(result.current.map((p) => p.id)).toEqual(['b']);
  });

  it('evaluates shouldShow with context', () => {
    mockRegistry.push(
      makePromo({ id: 'a', shouldShow: (ctx) => ctx.isTasksEnabled }),
      makePromo({ id: 'b', shouldShow: () => true })
    );
    mockContext.isTasksEnabled = false;
    const { result } = renderHook(() => usePromoSlot('dashboard-sidebar', 10));
    expect(result.current.map((p) => p.id)).toEqual(['b']);
  });

  it('sorts by priority descending', () => {
    mockRegistry.push(
      makePromo({ id: 'low', priority: 10 }),
      makePromo({ id: 'high', priority: 90 }),
      makePromo({ id: 'mid', priority: 50 })
    );
    const { result } = renderHook(() => usePromoSlot('dashboard-sidebar', 10));
    expect(result.current.map((p) => p.id)).toEqual(['high', 'mid', 'low']);
  });

  it('caps at maxUnits', () => {
    mockRegistry.push(
      makePromo({ id: 'a', priority: 90 }),
      makePromo({ id: 'b', priority: 80 }),
      makePromo({ id: 'c', priority: 70 })
    );
    const { result } = renderHook(() => usePromoSlot('dashboard-sidebar', 2));
    expect(result.current).toHaveLength(2);
    expect(result.current.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('returns empty array when promoEnabled is false', () => {
    mockRegistry.push(makePromo({ id: 'a' }));
    mockPromoEnabled = false;
    const { result } = renderHook(() => usePromoSlot('dashboard-sidebar', 10));
    expect(result.current).toEqual([]);
  });

  it('returns empty array when no promos qualify for a placement', () => {
    mockRegistry.push(makePromo({ id: 'a', placements: ['dashboard-sidebar'] }));
    const { result } = renderHook(() => usePromoSlot('agent-sidebar' as PromoPlacement, 10));
    expect(result.current).toEqual([]);
  });
});
