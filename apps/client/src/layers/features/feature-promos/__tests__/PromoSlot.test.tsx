/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { PromoDefinition } from '../model/promo-types';

// Mock usePromoSlot — controlled per-test via mockPromos
let mockPromos: PromoDefinition[] = [];
vi.mock('../model/use-promo-slot', () => ({
  usePromoSlot: () => mockPromos,
}));

// Mock PromoCard to isolate PromoSlot rendering logic
vi.mock('../ui/PromoCard', () => ({
  PromoCard: ({ promo }: { promo: PromoDefinition }) => (
    <div data-testid={`promo-card-${promo.id}`}>{promo.content.title}</div>
  ),
}));

import { PromoSlot } from '../ui/PromoSlot';

function makePromo(id: string): PromoDefinition {
  return {
    id,
    placements: ['dashboard-sidebar'],
    priority: 50,
    shouldShow: () => true,
    content: {
      icon: {} as PromoDefinition['content']['icon'],
      title: `Promo ${id}`,
      shortDescription: 'Desc',
      ctaLabel: 'CTA',
    },
    action: { type: 'action', handler: () => {} },
  };
}

describe('PromoSlot', () => {
  beforeEach(() => {
    mockPromos = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders zero DOM when no promos qualify', () => {
    const { container } = render(<PromoSlot placement="dashboard-sidebar" maxUnits={4} />);
    expect(container.querySelector('[data-slot="promo-slot"]')).not.toBeInTheDocument();
  });

  it('renders correct number of PromoCard children', () => {
    mockPromos = [makePromo('a'), makePromo('b'), makePromo('c')];
    render(<PromoSlot placement="dashboard-sidebar" maxUnits={4} />);
    expect(screen.getByTestId('promo-card-a')).toBeInTheDocument();
    expect(screen.getByTestId('promo-card-b')).toBeInTheDocument();
    expect(screen.getByTestId('promo-card-c')).toBeInTheDocument();
  });
});
