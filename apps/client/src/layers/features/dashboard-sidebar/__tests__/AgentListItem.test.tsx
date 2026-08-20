// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { act, render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { AgentListItem } from '../ui/AgentListItem';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => false };
});

vi.mock('@/layers/entities/agent', () => ({
  AgentAvatar: ({ emoji }: { emoji: string }) => <span data-testid="agent-face">{emoji}</span>,
}));

interface MockAgentStatus {
  kind: 'idle' | 'streaming' | 'pendingApproval' | 'error' | 'unseen';
  color: string;
  pulse: boolean;
  label: string;
}

const mockAgentStatus = vi.fn<() => MockAgentStatus>(() => ({
  kind: 'idle',
  color: 'rgba(128,128,128,0.08)',
  pulse: false,
  label: 'Idle',
}));

vi.mock('@/layers/entities/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/session')>();
  return {
    ...actual,
    useAgentHottestStatus: () => mockAgentStatus(),
    usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  };
});

// The switcher is `SessionSwitcher.test.tsx`'s subject. Here it is a marker, so
// these cases assert that the chip OPENS it without standing up a transport, a
// query client and a Radix portal to do it. `LiveSessionsChip` stays real: the
// row draws it twice and the two copies must be the same width.
vi.mock('../ui/SessionSwitcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/SessionSwitcher')>();
  return {
    ...actual,
    SessionSwitcher: ({ open, agentPath }: { open: boolean; agentPath: string }) =>
      open ? <div data-testid="session-switcher">{agentPath}</div> : null,
  };
});

// What the row hands its menu. Captured rather than discarded, because two of
// those handlers are the row's ONLY door to something under a thumb: the
// switcher and the profile drawer are satellites the row stops drawing on touch
// (P4.2), so "the menu was given a working handler" is the whole guarantee.
let lastMenuParams: Record<string, unknown> = {};
vi.mock('../ui/AgentRowMenuItems', () => ({
  // The row's menu reads `ui.sidebar` through the config entity, which needs a
  // transport this file deliberately does not stand up. The menu's own contents
  // are `AgentRowMenuItems.test.tsx`'s subject; here it is just "there is a
  // menu", so an empty list keeps the row's chrome honest (no ⋮ with nothing
  // behind it) without dragging a query client into every case.
  useAgentRowMenuNodes: (params: Record<string, unknown>) => {
    lastMenuParams = params;
    return [];
  },
}));

vi.mock('../ui/AgentActivityBadge', () => ({
  // Mirrors the real component's contract: idle renders nothing, so tests
  // can assert badge suppression the same way the real DOT_COLOR map does.
  AgentActivityBadge: ({ status, label }: { status: string; label: string }) =>
    status === 'idle' ? null : <span data-testid="activity-badge">{label}</span>,
}));

// ---------------------------------------------------------------------------
// Browser API mocks
// ---------------------------------------------------------------------------

beforeAll(() => {
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
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

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProps(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  return {
    path: '/agents/test-agent',
    agent: null,
    visual: { color: '#aaaaaa', emoji: '🤖' },
    isActive: false,
    onSelect: vi.fn(),
    onOpenProfile: vi.fn(),
    onRequestNewGroup: vi.fn(),
    onSessionClick: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
}

function renderItem(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  const props = buildProps(overrides);
  const result = render(
    <TooltipProvider>
      <SidebarProvider>
        <AgentListItem {...props} />
      </SidebarProvider>
    </TooltipProvider>
  );
  return { ...result, props };
}

function row() {
  return screen.getByTestId('agent-face').closest('[data-slot="agent-list-item"]')!;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AgentListItem', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAgentStatus.mockReturnValue({
      kind: 'idle',
      color: 'rgba(128,128,128,0.08)',
      pulse: false,
      label: 'Idle',
    });
  });

  // --- Rendering ---

  it('renders the agent display name from path fallback', () => {
    renderItem();
    expect(screen.getByText('test-agent')).toBeInTheDocument();
  });

  it('uses displayName prop when provided', () => {
    renderItem({ displayName: 'Custom Name' });
    expect(screen.getByText('Custom Name')).toBeInTheDocument();
  });

  it('renders the activity badge for a non-idle status', () => {
    mockAgentStatus.mockReturnValue({
      kind: 'streaming',
      color: 'rgb(34,197,94)',
      pulse: true,
      label: 'Working',
    });
    renderItem();
    expect(screen.getByTestId('activity-badge')).toHaveTextContent('Working');
  });

  it('renders no activity badge for an idle status', () => {
    renderItem();
    expect(screen.queryByTestId('activity-badge')).not.toBeInTheDocument();
  });

  // --- Row click behavior (BC-34) ---

  it('opens the conversation on click, whether or not the agent is already active', () => {
    const { props } = renderItem({ isActive: false });
    fireEvent.click(row());
    expect(props.onSelect).toHaveBeenCalledTimes(1);

    cleanup();
    const active = renderItem({ isActive: true });
    fireEvent.click(row());
    // An agent is a teammate, not a folder: the row has no expanded state to
    // toggle into, so the second press does the same thing as the first.
    expect(active.props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders no expansion panel — there is nothing to unfold', () => {
    const { container } = renderItem({ isActive: true });
    const listItem = container.querySelector('[data-slot="agent-list-item"]')!.closest('li')!;
    // The row's own wrapper is the only child. A panel would be a second one.
    expect(listItem.children).toHaveLength(1);
  });

  // --- The "N live" chip (BC-35) ---

  it('shows no chip when the model handed it no count', () => {
    // `liveCount` is absent below `LIVE_CHIP_MIN` — the model omits it rather
    // than sending a 1 for the row to compare against a threshold of its own
    // (`library-rules.test.ts` pins that boundary). Absent IS "no chip".
    renderItem();
    expect(screen.queryByRole('button', { name: /session switcher/i })).not.toBeInTheDocument();
  });

  it('draws the chip from the count the model handed it, counting nothing itself', () => {
    // **Nothing seeds the session store in this file**, so the only place a "2"
    // can come from is the prop. The row used to call `useLiveSessionCount` and
    // count for itself — sixty rows, sixty store subscriptions, and a second
    // answer to a question the model had already answered. Give the row that
    // hook back and this goes red: the store is empty, so it would read 0.
    renderItem({ liveCount: 2 });
    const chip = screen.getByRole('button', { name: /session switcher/i });
    expect(chip).toHaveAccessibleName(expect.stringContaining('2 live sessions'));
    expect(chip).toHaveTextContent('2 live');
  });

  it('the chip replaces the activity dot rather than doubling it', () => {
    mockAgentStatus.mockReturnValue({
      kind: 'streaming',
      color: 'rgb(34,197,94)',
      pulse: true,
      label: 'Working',
    });
    renderItem({ liveCount: 3 });
    expect(screen.getByRole('button', { name: /session switcher/i })).toBeInTheDocument();
    expect(screen.queryByTestId('activity-badge')).not.toBeInTheDocument();
  });

  it('opens the switcher from the chip, and only from the chip', () => {
    const { props } = renderItem({ liveCount: 2 });
    expect(screen.queryByTestId('session-switcher')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /session switcher/i }));
    expect(screen.getByTestId('session-switcher')).toHaveTextContent('/agents/test-agent');
    // The chip is a satellite, not a nested button: pressing it must not also
    // fire the row underneath.
    expect(props.onSelect).not.toHaveBeenCalled();
  });

  it('withholds the chip from a muted agent even while its work is live', () => {
    renderItem({ isMuted: true, liveCount: 4 });
    expect(screen.queryByRole('button', { name: /session switcher/i })).not.toBeInTheDocument();
  });

  // --- Accessibility ---

  it('does not nest interactive role="button" elements', () => {
    const { container } = renderItem({ isActive: true, liveCount: 2 });
    const rowButton = container.querySelector('[data-slot="agent-list-item"]')!;
    expect(rowButton).not.toHaveAttribute('role', 'button');
    expect(rowButton.querySelector('button')).toBeNull();
  });

  // --- Mute (DOR-339) ---

  describe('muted rendering', () => {
    it('shows no mute glyph by default', () => {
      renderItem();
      expect(screen.queryByLabelText('Muted')).not.toBeInTheDocument();
    });

    it('shows a mute glyph when muted, and does NOT dim the row (DOR-1098)', () => {
      const { container } = renderItem({ isMuted: true });
      // **Fewer signals, not less contrast.** The row used to wear `opacity-60`
      // on its outer wrapper, which took the agent's NAME to about 3:1 — under
      // the 4.5:1 every label in this product owes — so silencing an agent made
      // the one thing still worth reading hard to read. What mute removes is
      // what was asking: the bold, the badge, the dot. Red the moment a dimming
      // class comes back.
      const wrapper = container
        .querySelector('[data-slot="agent-list-item"]')!
        .closest('li')!.firstElementChild!;
      expect(wrapper.className).not.toContain('opacity-60');
      expect(screen.getByLabelText('Muted')).toBeInTheDocument();
    });

    it('drops the activity badge for a muted agent even while it is working', () => {
      mockAgentStatus.mockReturnValue({
        kind: 'streaming',
        color: 'rgb(34,197,94)',
        pulse: true,
        label: 'Working',
      });
      renderItem({ isMuted: true });
      expect(screen.queryByTestId('activity-badge')).not.toBeInTheDocument();
    });

    it('the row stays clickable while muted', () => {
      const { props } = renderItem({ isMuted: true, isActive: false });
      fireEvent.click(row());
      expect(props.onSelect).toHaveBeenCalledTimes(1);
    });
  });

  // --- The menu's doors to the row's satellites (P4.2) ---

  describe('what the row hands its menu', () => {
    it('opens the switcher from the menu, with no chip on the row at all', () => {
      // **The case the chip cannot cover.** Under a thumb the row draws no "N
      // live" chip, and below two live sessions it draws none at any width — so
      // the menu is the only door, and the switcher has to mount when it is
      // opened from there rather than only when the chip is on offer.
      renderItem();
      expect(screen.queryByTestId('session-switcher')).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /session switcher/ })).not.toBeInTheDocument();

      act(() => (lastMenuParams.onOpenSessions as () => void)());
      expect(screen.getByTestId('session-switcher')).toBeInTheDocument();
    });

    it('passes the profile drawer through, or null when the mesh cannot name the agent', () => {
      const onViewProfile = vi.fn();
      renderItem({ onViewProfile });
      (lastMenuParams.onViewProfile as () => void)();
      expect(onViewProfile).toHaveBeenCalledTimes(1);

      // The pair: no profile to open means no menu item offering one, which is
      // a `null` rather than a handler that quietly does nothing.
      cleanup();
      renderItem({ onViewProfile: undefined });
      expect(lastMenuParams.onViewProfile).toBeNull();
    });
  });
});
