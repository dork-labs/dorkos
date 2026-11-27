// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from '@/layers/shared/ui/button';
import { OneBar, BarTitle } from '../ui/OneBar';
import { TitleBar } from '../ui/TitleBar';
import { BarHarness } from './bar-harness';

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

describe('OneBar — a route bar cannot reach past the cluster (I1)', () => {
  // The cluster is the shell's (`src/app/header/BarFixedCluster.tsx`), mounted as a
  // sibling AFTER the bar, so it stays put while the bar cross-fades. What keeps
  // I1 true is that a route bar has no slot past `actions`: its entire output
  // lands before the cluster, whatever it renders. These assert the half OneBar
  // owns; the cluster's own test asserts the composition.
  it('ends with actions — the last slot a page is given', () => {
    render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>#general</BarTitle>}
          chips={<button aria-label="3 members">3</button>}
          actions={<Button size="xs">New schedule</Button>}
        />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual(['3 members', 'New schedule']);
  });
});

describe('OneBar — truncation priority (I2)', () => {
  it('lets state chips yield before they collide with identity on a phone', () => {
    render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>A long agent name</BarTitle>}
          chips={<span>account · waiting</span>}
        />
      </BarHarness>
    );
    const chipWrapper = screen.getByText('account · waiting').parentElement;
    expect(chipWrapper).toHaveClass('min-w-0', 'shrink');
    expect(chipWrapper).not.toHaveClass('shrink-0');
  });

  it('ellipsizes a long title and keeps the full text reachable', () => {
    // Room names are user-controlled and arrive from bridged Slack/Telegram
    // rooms too; an untruncated one blows the 36px row open on a phone.
    const long = 'Priya, Kai, Ikechi and 47 others about the quarterly migration plan';
    render(
      <BarHarness>
        <OneBar identity={<BarTitle>{long}</BarTitle>} />
      </BarHarness>
    );
    const title = screen.getByText(long);
    expect(title).toHaveClass('truncate', 'min-w-0');
    expect(title).toHaveAttribute('title', long);
  });

  it('gives `fill` the flex-1 basis, so the title beside it keeps its width', () => {
    // The 390px regression this pins: with the title and the filter bar as plain
    // auto-basis siblings in one wrapper, they shrank in proportion to their
    // content and the /activity title rendered at 0px while /team read "Te…".
    // The growing item has to be `fill`, never the title.
    const { container } = render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>Activity</BarTitle>}
          fill={<div data-testid="filters">filters</div>}
        />
      </BarHarness>
    );
    const fillWrapper = screen.getByTestId('filters').parentElement;
    expect(fillWrapper).toHaveClass('flex-1', 'min-w-0');
    expect(screen.getByText('Activity')).not.toHaveClass('flex-1');
    // And with no `fill`, a plain spacer holds the space open instead.
    expect(container.querySelector('.flex-1')).toBe(fillWrapper);
  });

  it('falls back to a spacer when a bar has no filling content', () => {
    const { container } = render(
      <BarHarness>
        <OneBar identity={<BarTitle>Workspaces</BarTitle>} />
      </BarHarness>
    );
    const spacer = container.querySelector('.flex-1');
    expect(spacer).toBeInTheDocument();
    expect(spacer).toBeEmptyDOMElement();
  });
});

describe('TitleBar', () => {
  it('is a OneBar with a name in it', () => {
    render(
      <BarHarness>
        <TitleBar title="Connections" />
      </BarHarness>
    );
    expect(screen.getByText('Connections')).toBeInTheDocument();
  });

  it('puts a page action in the actions slot', () => {
    render(
      <BarHarness>
        <TitleBar title="Team" actions={<Button size="xs">New Agent</Button>} />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual(['New Agent']);
  });
});
