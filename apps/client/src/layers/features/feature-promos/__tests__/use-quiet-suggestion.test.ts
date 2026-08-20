/**
 * One suggestion, or none (team-room-home spec D5.3).
 *
 * The quiet-state suggestion is not a second eligibility system: it runs the
 * registry's own `shouldShow` predicates, the registry's own dismissal list and
 * the registry's own global switch. What it adds is a hard cap of one and a
 * requirement that the promo has actually been written as a sentence somebody
 * would say out loud.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { forwardRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { PromoDefinition, PromoContext, PromoContent } from '../model/promo-types';

/** Minimal stub that satisfies the LucideIcon (ForwardRefExoticComponent) shape for tests. */
const StubIcon = forwardRef<SVGSVGElement>(() => null) as unknown as LucideIcon;

const mockRegistry: PromoDefinition[] = [];
vi.mock('../model/promo-registry', () => ({
  get PROMO_REGISTRY() {
    return mockRegistry;
  },
}));

let mockContext: PromoContext = {
  hasAdapter: () => false,
  isTasksEnabled: false,
  isMeshEnabled: false,
  isRelayEnabled: false,
  sessionCount: 0,
  agentCount: 0,
  taskCount: 0,
  daysSinceFirstUse: 0,
  isDesktopApp: false,
  remoteAccessConfigured: false,
};
vi.mock('../model/use-promo-context', () => ({
  usePromoContext: () => mockContext,
}));

let mockPromoEnabled = true;
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ promoEnabled: mockPromoEnabled }),
}));

// Dismissals moved to config (spec `sidebar-simplification` D4).
let mockDismissedIds: string[] = [];
vi.mock('@/layers/entities/config', () => ({
  usePromoDismissals: () => ({ dismissedIds: mockDismissedIds, dismissPromo: () => {} }),
}));

import { useQuietSuggestion } from '../model/use-quiet-suggestion';

function makePromo(
  overrides: Partial<Omit<PromoDefinition, 'content'>> & {
    id: string;
    content?: Partial<PromoContent>;
  }
): PromoDefinition {
  const { content, ...rest } = overrides;
  return {
    placements: ['dashboard-sidebar'],
    priority: 50,
    shouldShow: () => true,
    content: {
      icon: StubIcon,
      title: 'Test',
      shortDescription: 'Test promo',
      ctaLabel: 'Learn more',
      suggestion: { question: 'Want the thing?', action: 'Set it up' },
      ...content,
    },
    action: { type: 'action', handler: () => {} },
    ...rest,
  };
}

describe('useQuietSuggestion', () => {
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
      isDesktopApp: false,
      remoteAccessConfigured: false,
    };
  });

  it('offers the one suggestion the reader qualifies for', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current?.id).toBe('schedules');
  });

  it('offers only the highest-priority one when two qualify — never a stack', () => {
    mockRegistry.push(
      makePromo({ id: 'quieter', priority: 10 }),
      makePromo({ id: 'louder', priority: 90 })
    );
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current?.id).toBe('louder');
  });

  it('ignores a promo that has no suggestion written for it, however well it qualifies', () => {
    // A card can say "Learn more" under an icon. A line in a quiet room has to
    // be a sentence, and a promo without one has nothing to say here.
    mockRegistry.push(
      makePromo({ id: 'card-only', priority: 90, content: { suggestion: undefined } }),
      makePromo({ id: 'has-a-line', priority: 10 })
    );
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current?.id).toBe('has-a-line');
  });

  it('says nothing when the reader qualifies for nothing', () => {
    mockRegistry.push(makePromo({ id: 'schedules', shouldShow: (ctx) => ctx.isTasksEnabled }));
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current).toBeNull();
  });

  it('runs the registry predicate rather than a second rule of its own', () => {
    mockRegistry.push(makePromo({ id: 'schedules', shouldShow: (ctx) => ctx.sessionCount > 0 }));
    mockContext.sessionCount = 3;
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current?.id).toBe('schedules');
  });

  it('does not come back once it has been dismissed', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    mockDismissedIds = ['schedules'];
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current).toBeNull();
  });

  it('says nothing at all when suggestions are switched off in settings', () => {
    mockRegistry.push(makePromo({ id: 'schedules' }));
    mockPromoEnabled = false;
    const { result } = renderHook(() => useQuietSuggestion());
    expect(result.current).toBeNull();
  });
});
