/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { PromoDefinition } from '../model/promo-types';

// Mock PromoDialog to avoid ResponsiveDialog complexity in unit tests
vi.mock('../ui/PromoDialog', () => ({
  PromoDialog: () => null,
}));

import { PromoCard } from '../ui/PromoCard';

function makePromo(overrides?: Partial<PromoDefinition>): PromoDefinition {
  return {
    id: 'test-promo',
    placements: ['dashboard-sidebar'],
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

  it('renders title and short description in the compact row', () => {
    render(<PromoCard promo={makePromo()} />);
    expect(screen.getByText('Test Title')).toBeInTheDocument();
    expect(screen.getByText('Test description')).toBeInTheDocument();
    expect(screen.getByRole('button')).toHaveAttribute('data-slot', 'promo-card-compact');
  });

  it('separates by tint and carries no hairline anywhere in it (R1)', () => {
    // The sidebar removed every border in favour of one `--sidebar-accent`
    // ramp, and a card that kept its own outline was the last thing in the
    // panel drawing a box. `--muted` is banned here for the same reason
    // `SidebarRow` bans it: it is lighter than the panel in light mode and
    // darker in dark, so it separates in opposite directions between themes.
    const { container } = render(<PromoCard promo={makePromo()} />);
    const card = screen.getByRole('button');
    expect(card.className).toMatch(/\bbg-sidebar-accent\/40\b/);
    expect(card.className).toMatch(/\bhover:bg-sidebar-accent\/70\b/);
    expect(container.innerHTML).not.toMatch(/\bborder\b|\bbg-card\b|\bbg-muted\b/);
  });

  it('renders open-dialog component with open=true after click', () => {
    const MockDialog: React.FC<{ open: boolean; onOpenChange: (v: boolean) => void }> = vi.fn(
      () => null
    );
    const promo = makePromo({
      action: { type: 'open-dialog', component: MockDialog },
    });
    render(<PromoCard promo={promo} />);

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
