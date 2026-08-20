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

// The card's × writes to config. The spy is what the dismissal case asserts on.
const dismissPromo = vi.fn();
vi.mock('@/layers/entities/config', () => ({
  usePromoDismissals: () => ({ dismissedIds: [], dismissPromo }),
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
    // Named rather than "the only button": the card has two now, and the ×
    // beside it is the point of the cases below.
    expect(screen.getByRole('button', { name: /Test Title/ })).toHaveAttribute(
      'data-slot',
      'promo-card-compact'
    );
  });

  it('offers a dismiss control, always visible, that records the promo id', () => {
    // What this catches: the card shipping without any way to say no — which is
    // what it did, because the spec put the × on the `dashboard-main` format
    // that was retired with `team-room-home` (spec `sidebar-simplification` D4).
    render(<PromoCard promo={makePromo()} />);

    const dismiss = screen.getByRole('button', { name: 'Dismiss' });
    // Not hover-gated: a control a touch screen cannot reveal is a control it
    // does not have.
    expect(dismiss.className).not.toMatch(/\bopacity-0\b/);

    fireEvent.click(dismiss);
    expect(dismissPromo).toHaveBeenCalledWith('test-promo');
  });

  it('does not activate the promo when the dismiss control is pressed', () => {
    // What this catches: nesting the × inside the card's own button, which is
    // invalid HTML and fires both handlers in the browsers that tolerate it —
    // so saying "no thanks" would open the dialog it is refusing.
    const MockDialog: React.FC<{ open: boolean; onOpenChange: (v: boolean) => void }> = vi.fn(
      () => null
    );
    render(
      <PromoCard promo={makePromo({ action: { type: 'open-dialog', component: MockDialog } })} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));

    // Asserted over EVERY render rather than the last one: pressing × causes no
    // state change of its own, so "the most recent call" would be the mount's
    // and would read `open: false` whether or not the activation also fired.
    const opened = vi
      .mocked(MockDialog)
      .mock.calls.some(([props]) => (props as { open: boolean }).open);
    expect(opened).toBe(false);
  });

  it('separates by tint and carries no hairline anywhere in it (R1)', () => {
    // The sidebar removed every border in favour of one `--sidebar-accent`
    // ramp, and a card that kept its own outline was the last thing in the
    // panel drawing a box. `--muted` is banned here for the same reason
    // `SidebarRow` bans it: it is lighter than the panel in light mode and
    // darker in dark, so it separates in opposite directions between themes.
    const { container } = render(<PromoCard promo={makePromo()} />);
    const card = screen.getByRole('button', { name: /Test Title/ });
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
