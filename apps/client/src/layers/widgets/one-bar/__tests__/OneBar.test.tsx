// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { Button } from '@/layers/shared/ui/button';
import { OneBar, BarTitle } from '../ui/OneBar';
import { TitleBar } from '../ui/TitleBar';
import { BarHarness } from './bar-harness';

// The three controls of the fixed cluster, each stubbed to something the DOM
// order assertion can name. Search is the real component's own label; the other
// two stand in for widgets with data needs this suite does not care about.
vi.mock('@/layers/features/top-nav', () => ({
  CommandPaletteTrigger: () => <button aria-label="Open command palette">Search</button>,
}));
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

/** Every button in the bar, in the order the DOM holds them. */
function buttonLabels() {
  return screen.getAllByRole('button').map((el) => el.getAttribute('aria-label') ?? el.textContent);
}

describe('OneBar — the fixed cluster (I1)', () => {
  it('ends every bar with search, inbox, right-panel toggle, in that order', () => {
    render(
      <BarHarness>
        <OneBar identity={<BarTitle>Workspaces</BarTitle>} />
      </BarHarness>
    );
    expect(buttonLabels().slice(-3)).toEqual([
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);
  });

  it('keeps the cluster last when the page contributes actions', () => {
    // The one slot a consumer has near the right edge is `actions`, and it sits
    // BEFORE search. There is no slot after the toggle, which is what makes "no
    // page can wedge a control into the cluster" a property of the component
    // rather than a rule people have to remember.
    render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>Scheduled</BarTitle>}
          actions={<Button size="xs">New Task</Button>}
        />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual([
      'New Task',
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);
  });

  it('keeps the cluster last when the page contributes chips as well', () => {
    render(
      <BarHarness>
        <OneBar
          identity={<BarTitle>#general</BarTitle>}
          chips={<button aria-label="3 members">3</button>}
          actions={<Button size="xs">New Task</Button>}
        />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual([
      '3 members',
      'New Task',
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);
  });

  it('never lets the cluster shrink', () => {
    const { container } = render(
      <BarHarness>
        <OneBar identity={<BarTitle>Home</BarTitle>} />
      </BarHarness>
    );
    const cluster = screen.getByLabelText('Toggle right panel').parentElement;
    expect(cluster).toHaveClass('shrink-0');
    // …and the identity zone is the half that gives ground.
    expect(container.querySelector('.min-w-0')).toBeInTheDocument();
  });
});

describe('OneBar — truncation (I2)', () => {
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
});

describe('TitleBar', () => {
  it('is a OneBar with a name in it — cluster included', () => {
    render(
      <BarHarness>
        <TitleBar title="Connections" />
      </BarHarness>
    );
    expect(screen.getByText('Connections')).toBeInTheDocument();
    expect(buttonLabels().slice(-3)).toEqual([
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);
  });

  it('puts a page action before the cluster', () => {
    render(
      <BarHarness>
        <TitleBar title="Team" actions={<Button size="xs">New Agent</Button>} />
      </BarHarness>
    );
    expect(buttonLabels()).toEqual([
      'New Agent',
      'Open command palette',
      'Inbox',
      'Toggle right panel',
    ]);
  });
});
