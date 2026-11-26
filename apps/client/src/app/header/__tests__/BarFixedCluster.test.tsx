// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button, TooltipProvider } from '@/layers/shared/ui';
import { OneBar, BarTitle } from '@/layers/widgets/one-bar';
import { BarFixedCluster } from '../BarFixedCluster';

// The two cluster members with data needs of their own. Search is the real
// component — its label is what the ordering assertion names.
vi.mock('@/layers/widgets/inbox-bell', () => ({
  InboxBell: () => <button aria-label="Inbox">Inbox</button>,
}));
vi.mock('@/layers/features/right-panel', () => ({
  RightPanelToggle: () => <button aria-label="Toggle right panel">Panel</button>,
}));

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(cleanup);

/** Every button on screen, in the order the DOM holds them. */
function buttonLabels() {
  return screen.getAllByRole('button').map((el) => el.getAttribute('aria-label') ?? el.textContent);
}

describe('BarFixedCluster — the last three controls (I1)', () => {
  it('renders search, inbox, right-panel toggle, in that order', () => {
    render(
      <TooltipProvider>
        <BarFixedCluster />
      </TooltipProvider>
    );
    expect(buttonLabels()).toEqual(['Open command palette', 'Inbox', 'Toggle right panel']);
  });

  it('never shrinks, so a long room name eats the identity zone instead', () => {
    render(
      <TooltipProvider>
        <BarFixedCluster />
      </TooltipProvider>
    );
    expect(screen.getByLabelText('Toggle right panel').parentElement).toHaveClass('shrink-0');
  });

  it('comes after everything a route bar renders', () => {
    // The composition the shell performs, asserted end to end: bar first,
    // cluster second, so the three fixed controls are the last three buttons on
    // the row no matter what the page contributed.
    render(
      <TooltipProvider>
        <OneBar
          identity={<BarTitle>Scheduled</BarTitle>}
          actions={<Button size="xs">New schedule</Button>}
        />
        <BarFixedCluster />
      </TooltipProvider>
    );
    expect(buttonLabels()).toEqual([
      'New schedule',
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);

    // I1 by name: the cluster is addressable via its slot, and it is the row's
    // LAST element — a bar that rendered anything after it would make the slot
    // stop being :last-child. This is the assertion e2e can reuse verbatim.
    const cluster = document.querySelector('[data-slot="bar-fixed-cluster"]');
    expect(cluster).not.toBeNull();
    expect(cluster?.parentElement?.lastElementChild).toBe(cluster);
    expect(cluster?.querySelectorAll('button')).toHaveLength(3);
  });
});
