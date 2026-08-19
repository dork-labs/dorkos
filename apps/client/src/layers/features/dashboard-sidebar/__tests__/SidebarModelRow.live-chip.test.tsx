// @vitest-environment jsdom
/**
 * The wire between the model's `liveCount` and the row that draws it.
 *
 * **Why this exists as its own file.** `AgentListItem.test.tsx` proves the row
 * draws a chip from the `liveCount` prop, and `library-rules.test.ts` proves the
 * model puts the right number on `SidebarRowModel.liveCount`. Both stayed green
 * with the one line that connects them deleted — `SidebarModelRow` simply
 * stopped passing it, every agent row lost its chip, and 790 tests said nothing.
 * A seam covered from both ends and not across is not covered.
 *
 * So this renders through {@link SidebarModelRow} — the component that reads the
 * model and chooses what to hand each row — and asserts the chip on the far side
 * of it. Deleting the `liveCount` spread in `AgentRowFromModel` turns it red.
 *
 * @module features/dashboard-sidebar/__tests__/SidebarModelRow.live-chip
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';
import type { SidebarRowModel } from '../model/build-sidebar-model';
import { SidebarModelRow } from '../ui/SidebarModelRow';

// ---------------------------------------------------------------------------
// Mocks — everything EXCEPT the wire under test
// ---------------------------------------------------------------------------

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useIsMobile: () => false };
});

// The row's chrome, which in production is a context built from the router, the
// query cache, the mesh and the transport. None of that decides a chip.
const openTarget = vi.fn();
vi.mock('../ui/SidebarChrome', () => ({
  useSidebarChrome: () => ({
    manifests: {},
    displayNames: {},
    roomsById: new Map(),
    activeTarget: null,
    openTarget,
    newSession: vi.fn(),
    viewProfileFor: () => vi.fn(),
    requestNewGroup: vi.fn(),
  }),
}));

vi.mock('@/layers/entities/agent', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/agent')>();
  return {
    ...actual,
    useAgentVisual: () => ({ color: '#aaaaaa', emoji: '🤖' }),
    AgentIdentity: ({ name }: { name: string }) => <span data-testid="agent-identity">{name}</span>,
  };
});

vi.mock('@/layers/entities/session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/session')>();
  return {
    ...actual,
    // Idle, and deliberately so: if the chip could be drawn from the live status
    // fan-out instead of from the model, this file would be the one that missed
    // it. The store is empty and the status is idle, so a chip here can only
    // have travelled down the wire under test.
    useAgentHottestStatus: () => ({ kind: 'idle' as const, label: 'Idle' }),
    usePulseMotion: () => ({ animate: undefined, transition: undefined }),
  };
});

vi.mock('../ui/SessionSwitcher', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ui/SessionSwitcher')>();
  return {
    ...actual,
    SessionSwitcher: () => null,
  };
});

vi.mock('../ui/AgentRowMenuItems', () => ({
  useAgentRowMenuNodes: () => [],
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeAll(() => {
  globalThis.ResizeObserver = class {
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

const AGENT_PATH = '/agents/saffron';

/**
 * One agent row as the model emits it.
 *
 * `draggable: false` so the row is not wrapped in a drag source — the drag layer
 * is `SidebarDnd.test.tsx`'s subject and needs a `DndContext` this file has no
 * reason to stand up. The chip travels the same path either way: it is
 * `AgentRowFromModel` that reads the model, inside both branches.
 *
 * @param overrides - What this case is actually about.
 */
function agentRow(overrides: Partial<SidebarRowModel> = {}): SidebarRowModel {
  return {
    key: `agent:${AGENT_PATH}`,
    target: { kind: 'agent', path: AGENT_PATH },
    glyph: { kind: 'agent-avatar', agentPath: AGENT_PATH },
    primary: 'saffron',
    reservesVerbLine: false,
    unread: { tier: 'none' },
    muted: false,
    draggable: false,
    reason: 'library:agents',
    ...overrides,
  };
}

/** Render one model row through the dispatcher that reads the model. */
function renderRow(row: SidebarRowModel) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarModelRow row={row} keyPrefix="ungrouped" />
      </SidebarProvider>
    </TooltipProvider>
  );
}

/** The "N live" chip, or `null` when the row drew none. */
function chip() {
  return screen.queryByRole('button', { name: /live sessions — open the session switcher/i });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SidebarModelRow hands an agent row its liveCount', () => {
  it('renders the row at all — the control every claim below rests on', () => {
    // Without this, "no chip" below could mean "no row", and the negative case
    // would pass against a component that threw on mount.
    renderRow(agentRow());
    expect(screen.getByTestId('agent-identity')).toHaveTextContent('saffron');
  });

  it('draws the chip, with the model’s number, when the model sent one', () => {
    renderRow(agentRow({ liveCount: 2 }));
    const control = chip();
    expect(control).not.toBeNull();
    expect(control).toHaveTextContent('2 live');
    expect(control).toHaveAccessibleName(expect.stringContaining('2 live sessions'));
  });

  it('passes the number through rather than a threshold of its own', () => {
    // Three, not two: a wire that hard-coded the minimum it once compared
    // against would still say "2 live" here.
    renderRow(agentRow({ liveCount: 3 }));
    expect(chip()).toHaveTextContent('3 live');
  });

  it('draws no chip when the model sent none', () => {
    // The model omits `liveCount` below `LIVE_CHIP_MIN`, so absence is the whole
    // condition — there is no zero to compare against.
    renderRow(agentRow());
    expect(chip()).toBeNull();
  });
});
