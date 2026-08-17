// @vitest-environment jsdom
/**
 * The face on a sidebar agent row opens that agent's profile (DOR-957).
 *
 * A separate file from `AgentListItem.test.tsx` for one reason: that file stubs
 * `AgentIdentity` out entirely, and the whole claim here lives inside it — the
 * FACE is the control, the rest of the row is not. Stubbing the lockup would
 * leave nothing to press.
 *
 * The sharp edge is the row's own click. It selects the agent and opens its
 * last session, and it wraps the face; without a stop, one press on the face
 * would do both — open a profile AND navigate out from under it.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import { AgentListItem } from '../ui/AgentListItem';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => false };
});

vi.mock('@/layers/entities/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/session')>();
  return {
    ...actual,
    useAgentHottestStatus: () => ({
      kind: 'idle' as const,
      color: 'rgba(128,128,128,0.08)',
      pulse: false,
      label: 'Idle',
    }),
    usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  };
});

vi.mock('../ui/AgentRowMenuItems', () => ({
  // The row's menu reads `ui.sidebar` through the config entity, which needs a
  // transport this file deliberately does not stand up. The menu's own contents
  // are `AgentRowMenuItems.test.tsx`'s subject; here it is just "there is a
  // menu", so an empty list keeps the row's chrome honest (no ⋮ with nothing
  // behind it) without dragging a query client into every case.
  useAgentRowMenuNodes: () => [],
}));

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

beforeEach(() => vi.clearAllMocks());
afterEach(cleanup);

function renderRow(overrides: Partial<Parameters<typeof AgentListItem>[0]> = {}) {
  const props = {
    path: '/projects/alpha',
    agent: null,
    displayName: 'Alpha',
    visual: { color: '#aaaaaa', emoji: '🤖' },
    isActive: false,
    isExpanded: false,
    onSelect: vi.fn(),
    onToggleExpand: vi.fn(),
    onRequestNewGroup: vi.fn(),
    sessions: [],
    isLoadingSessions: false,
    activeSessionId: null,
    onSessionClick: vi.fn(),
    onNewSession: vi.fn(),
    ...overrides,
  };
  render(
    <TooltipProvider>
      <SidebarProvider>
        <AgentListItem {...props} />
      </SidebarProvider>
    </TooltipProvider>
  );
  return props;
}

const face = () => screen.getByRole('button', { name: 'Open Alpha’s profile' });

describe('the face on a sidebar agent row', () => {
  it('opens the profile when pressed', async () => {
    const user = userEvent.setup();
    const onViewProfile = vi.fn();
    renderRow({ onViewProfile });

    await user.click(face());

    expect(onViewProfile).toHaveBeenCalledTimes(1);
  });

  it('does not also select the agent — one press, one thing', async () => {
    const user = userEvent.setup();
    const props = renderRow({ onViewProfile: vi.fn() });

    await user.click(face());

    expect(props.onSelect).not.toHaveBeenCalled();
    expect(props.onToggleExpand).not.toHaveBeenCalled();
  });

  it('leaves the row itself selecting the agent, as it always did', async () => {
    const user = userEvent.setup();
    const props = renderRow({ onViewProfile: vi.fn() });

    await user.click(screen.getByText('Alpha'));

    expect(props.onSelect).toHaveBeenCalledTimes(1);
  });

  it('draws no control at all when handed no destination', () => {
    // The component's own contract, not a product state: the sidebar always
    // supplies a destination now — `SidebarChrome.viewProfileFor` falls back to
    // the docked profile for an agent the roster cannot name (DOR-1255, covered
    // in `DashboardSidebar.test.tsx`). What this pins is that the row draws no
    // dead affordance when there is genuinely nowhere to go.
    renderRow({ onViewProfile: undefined });

    expect(screen.queryByRole('button', { name: 'Open Alpha’s profile' })).toBeNull();
  });
});
