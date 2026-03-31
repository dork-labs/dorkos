/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { PromoDefinition } from '../model/promo-types';

const mockDismissPromo = vi.fn();
vi.mock('@/layers/shared/model', () => ({
  useAppStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ dismissPromo: mockDismissPromo }),
  useIsMobile: () => false,
}));

// Mock PromoDialog to avoid ResponsiveDialog complexity in unit tests
vi.mock('../ui/PromoDialog', () => ({
  PromoDialog: () => null,
}));

import { PromoCard } from '../ui/PromoCard';

function makePromo(overrides?: Partial<PromoDefinition>): PromoDefinition {
  return {
    id: 'test-promo',
    placements: ['dashboard-main'],
    priority: 50,
    shouldShow: () => true,
    content: {
      icon: ({ className }: { className?: string }) => (
        <span data-testid="icon" className={className} />
      ),
      title: 'Test Title',
      shortDescription: 'Test description',
      ctaLabel: 'Learn more',
    } as PromoDefinition['content'],
    action: { type: 'dialog', component: () => <div>Dialog</div> },
    ...overrides,
  };
}

describe('PromoCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders title, short description, and CTA label in standard format', () => {
    render(<PromoCard promo={makePromo()} placement="dashboard-main" />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test description')).toBeInTheDocument();
    expect(screen.getByText('Learn more')).toBeInTheDocument();
  });

  it('standard format shows dismiss X button', () => {
    render(<PromoCard promo={makePromo()} placement="dashboard-main" />);
    expect(screen.getByLabelText('Dismiss suggestion')).toBeInTheDocument();
  });

  it('compact format does not show dismiss X button', () => {
    render(<PromoCard promo={makePromo()} placement="dashboard-sidebar" />);
    expect(screen.queryByLabelText('Dismiss suggestion')).not.toBeInTheDocument();
  });

  it('clicking dismiss calls dismissPromo with correct ID', () => {
    render(<PromoCard promo={makePromo({ id: 'my-promo' })} placement="dashboard-main" />);
    fireEvent.click(screen.getByLabelText('Dismiss suggestion'));
    expect(mockDismissPromo).toHaveBeenCalledWith('my-promo');
  });

  it('renders in compact format for dashboard-sidebar placement', () => {
    render(<PromoCard promo={makePromo()} placement="dashboard-sidebar" />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('data-slot', 'promo-card-compact');
  });

  it('renders in compact format for agent-sidebar placement', () => {
    render(<PromoCard promo={makePromo()} placement="agent-sidebar" />);
    expect(screen.getByRole('button')).toHaveAttribute('data-slot', 'promo-card-compact');
  });

  it('renders open-dialog component with open=true after click', () => {
    const MockDialog: React.FC<{ open: boolean; onOpenChange: (v: boolean) => void }> = vi.fn(
      () => null
    );
    const promo = makePromo({
      action: { type: 'open-dialog', component: MockDialog },
    });
    render(<PromoCard promo={promo} placement="dashboard-main" />);

    // Initially mounted with open=false (standard dialog contract)
    const calls = vi.mocked(MockDialog).mock.calls;
    expect(calls[calls.length - 1][0]).toMatchObject({ open: false });

    vi.mocked(MockDialog).mockClear();
    fireEvent.click(screen.getByRole('button', { name: /Test Title/i }));

    // After click, re-rendered with open=true
    const callsAfter = vi.mocked(MockDialog).mock.calls;
    expect(callsAfter[callsAfter.length - 1][0]).toMatchObject({ open: true });
  });
});
