// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from '@/layers/shared/ui/button';
import { OneBar, BarTitle, BarFixedCluster } from '../ui/OneBar';
import { TitleBar } from '../ui/TitleBar';
import { BarHarness } from './bar-harness';

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
      <BarHarness>
        <BarFixedCluster />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual(['Open command palette', 'Inbox', 'Toggle right panel']);
  });

  it('never shrinks, so a long room name eats the identity zone instead', () => {
    render(
      <BarHarness>
        <BarFixedCluster />
      </BarHarness>
    );
    expect(screen.getByLabelText('Toggle right panel').parentElement).toHaveClass('shrink-0');
  });
});

describe('OneBar — a route bar cannot reach past the cluster (I1)', () => {
  // The cluster is the shell's, mounted as a sibling AFTER the bar, so it stays
  // put while the bar cross-fades. What keeps I1 true is that a route bar has no
  // slot past `actions`: its entire output lands before the cluster, whatever it
  // renders. These assert the half OneBar owns.
  it('renders no cluster of its own', () => {
    render(
      <BarHarness>
        <OneBar identity={<BarTitle>Workspaces</BarTitle>} />
      </BarHarness>
    );
    expect(screen.queryByLabelText('Open command palette')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Inbox')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Toggle right panel')).not.toBeInTheDocument();
  });

  it('ends with actions — the last slot a page is given', () => {
    render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>#general</BarTitle>}
          chips={<button aria-label="3 members">3</button>}
          actions={<Button size="xs">New Task</Button>}
        />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual(['3 members', 'New Task']);
  });

  it('places the cluster after everything a bar renders', () => {
    // The composition the shell performs, asserted end to end: bar first,
    // cluster second, so the three fixed controls are the last three buttons on
    // the row no matter what the page contributed.
    render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>Scheduled</BarTitle>}
          actions={<Button size="xs">New Task</Button>}
        />
        <BarFixedCluster />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual([
      'New Task',
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);
  });
});

describe('OneBar — truncation priority (I2)', () => {
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
