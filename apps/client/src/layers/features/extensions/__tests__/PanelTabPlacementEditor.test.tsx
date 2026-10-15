/**
 * @vitest-environment jsdom
 */
/**
 * "Shows in" for a mini app's right-panel tabs, on its Settings card (spec
 * `mini-app-placement`). Every change is written as one whole placement through
 * `setPlacement`, so the assertions read the placement it was handed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type {
  MiniAppPlacement,
  PlacementTargets,
  SavedPlacement,
} from '@dorkos/shared/mini-app-placement';
import type { RightPanelContribution } from '@/layers/shared/model';

let mockSaved: SavedPlacement[] = [];
const mockSetPlacement = vi.fn();
let mockAgents: Array<{ id: string; name: string; displayName?: string }> = [];
let mockRooms: Array<{ id: string; kind: 'channel' | 'dm'; slug: string | null; title: string }> =
  [];
let mockContributions: RightPanelContribution[] = [];

vi.mock('@/layers/entities/config', () => ({
  usePanelTabPlacements: () => mockSaved,
  useSetPanelTabPlacement: () => ({ setPlacement: mockSetPlacement, isPending: false }),
}));
vi.mock('@/layers/entities/mesh', () => ({
  useRegisteredAgents: () => ({ data: { agents: mockAgents } }),
}));
vi.mock('@/layers/entities/room', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/entities/room')>();
  return { ...actual, useRooms: () => ({ data: mockRooms }) };
});
vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return { ...actual, useSlotContributions: () => mockContributions };
});

import { PanelTabPlacementSection } from '../ui/PanelTabPlacementEditor';

const MockIcon = () => null;

function targets(overrides: Partial<PlacementTargets> = {}): PlacementTargets {
  return { agents: [], rooms: [], pages: [], ...overrides };
}

function placement(
  show: Partial<PlacementTargets>,
  hide: Partial<PlacementTargets> = {}
): MiniAppPlacement {
  return { show: targets(show), hide: targets(hide) };
}

function tab(
  id: string,
  title: string,
  declaredPlacement: MiniAppPlacement | null = null,
  extensionId = 'social-queue'
): RightPanelContribution {
  return {
    id,
    title,
    icon: MockIcon as unknown as RightPanelContribution['icon'],
    component: () => null,
    extensionId,
    declaredPlacement,
  };
}

const QUEUE_ID = 'social-queue:queue';

/**
 * The one placement the last write sent, for the queue tab. Only `show` and
 * `hide` are read: a chip removal spreads the saved entry, so its `tab` key
 * rides along, and `withPanelTabPlacement` rebuilds the entry from the two
 * lists anyway.
 */
function lastWrite(): MiniAppPlacement {
  expect(mockSetPlacement).toHaveBeenCalledTimes(1);
  const [tabId, written] = mockSetPlacement.mock.calls[0] as [string, MiniAppPlacement];
  expect(tabId).toBe(QUEUE_ID);
  return { show: written.show, hide: written.hide };
}

function renderSection(extensionId = 'social-queue') {
  return render(<PanelTabPlacementSection extensionId={extensionId} />);
}

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
  // cmdk and Radix use ResizeObserver and scrollIntoView internally.
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
});

beforeEach(() => {
  mockSaved = [];
  mockAgents = [
    { id: 'agent-1', name: 'writer', displayName: 'Writer' },
    { id: 'agent-2', name: 'researcher', displayName: 'Researcher' },
  ];
  mockRooms = [
    { id: 'room-1', kind: 'channel', slug: 'launch', title: 'Launch' },
    { id: 'room-2', kind: 'channel', slug: 'ops', title: 'Ops' },
  ];
  mockContributions = [tab(QUEUE_ID, 'Queue')];
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('PanelTabPlacementSection', () => {
  it('renders nothing when the mini app has no right-panel tab', () => {
    mockContributions = [tab('other:tab', 'Other', null, 'other-app')];
    const { container } = renderSection();
    expect(container).toBeEmptyDOMElement();
  });

  it('selects Everywhere when the placement is the built-in default', () => {
    renderSection();
    expect(screen.getByText('Panel tab shows')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Everywhere' })).toHaveAttribute(
      'aria-checked',
      'true'
    );
    expect(screen.getByRole('radio', { name: 'Only in…' })).toHaveAttribute(
      'aria-checked',
      'false'
    );
    // No chips or Add picker while it shows everywhere.
    expect(screen.queryByRole('button', { name: /^Add a place/ })).not.toBeInTheDocument();
  });

  it('switching to "Only in…" writes show.pages without the wildcard, keeping the rest', () => {
    mockSaved = [
      {
        tab: QUEUE_ID,
        ...placement({ pages: ['*', 'activity'], agents: ['agent-1'] }, { rooms: ['room-2'] }),
      },
    ];
    renderSection();

    fireEvent.click(screen.getByRole('radio', { name: 'Only in…' }));

    expect(lastWrite()).toEqual(
      placement({ pages: ['activity'], agents: ['agent-1'] }, { rooms: ['room-2'] })
    );
  });

  it('switching back to Everywhere writes the wildcard', () => {
    mockContributions = [tab(QUEUE_ID, 'Queue', placement({ rooms: ['room-1'] }))];
    renderSection();

    fireEvent.click(screen.getByRole('radio', { name: 'Everywhere' }));

    expect(lastWrite()).toEqual(placement({ rooms: ['room-1'], pages: ['*'] }));
  });

  it('names agents, channels and pages on their chips, and a gone agent as gone', () => {
    mockSaved = [
      {
        tab: QUEUE_ID,
        ...placement({ agents: ['agent-1', 'agent-gone'], rooms: ['room-1'], pages: ['tasks'] }),
      },
    ];
    renderSection();

    expect(screen.getByRole('radio', { name: 'Only in…' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('button', { name: 'Remove Writer' })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Remove An agent that is gone' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove #launch' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove Scheduled' })).toBeInTheDocument();
    // Ids never appear as chip text.
    expect(screen.queryByText('agent-1')).not.toBeInTheDocument();
    expect(screen.queryByText('room-1')).not.toBeInTheDocument();
  });

  it('removing a chip writes the list without it', () => {
    mockSaved = [{ tab: QUEUE_ID, ...placement({ agents: ['agent-1'], rooms: ['room-1'] }) }];
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Remove #launch' }));

    expect(lastWrite()).toEqual(placement({ agents: ['agent-1'] }));
  });

  it('says it shows nowhere when "Only in…" lists nothing', () => {
    mockSaved = [{ tab: QUEUE_ID, ...placement({}) }];
    renderSection();
    expect(screen.getByText('Shows nowhere yet. Add a place.')).toBeInTheDocument();
  });

  it('the Add picker adds an agent to show and takes it out of hide', () => {
    mockSaved = [
      {
        tab: QUEUE_ID,
        ...placement({ rooms: ['room-1'] }, { agents: ['agent-2'], rooms: ['room-2'] }),
      },
    ];
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Add a place for the Queue tab' }));
    const list = screen.getByRole('listbox');
    // Places already shown are not offered again.
    expect(within(list).queryByRole('option', { name: /#launch/ })).not.toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /#ops/ })).toBeInTheDocument();
    expect(within(list).getByRole('option', { name: /Every chat/ })).toBeInTheDocument();

    fireEvent.click(within(list).getByRole('option', { name: /Researcher/ }));

    expect(lastWrite()).toEqual(
      placement({ rooms: ['room-1'], agents: ['agent-2'] }, { rooms: ['room-2'] })
    );
    // Picking closes the picker.
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('the Add picker adds a page', () => {
    mockSaved = [{ tab: QUEUE_ID, ...placement({}) }];
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Add a place for the Queue tab' }));
    fireEvent.click(within(screen.getByRole('listbox')).getByRole('option', { name: /Activity/ }));

    expect(lastWrite()).toEqual(placement({ pages: ['activity'] }));
  });

  it('lists "Hidden in" chips and removing one writes hide without it', () => {
    mockSaved = [
      { tab: QUEUE_ID, ...placement({ pages: ['*'] }, { rooms: ['room-2'], agents: ['agent-1'] }) },
    ];
    renderSection();

    expect(screen.getByRole('group', { name: 'Hidden in' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show in Writer again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show in #ops again' }));

    expect(lastWrite()).toEqual(placement({ pages: ['*'] }, { agents: ['agent-1'] }));
  });

  it('shows a tab hidden everywhere as an Everywhere chip under "Hidden in"', () => {
    mockSaved = [{ tab: QUEUE_ID, ...placement({ pages: ['*'] }, { pages: ['*'] }) }];
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Show in Everywhere again' }));
    expect(lastWrite()).toEqual(placement({ pages: ['*'] }, {}));
  });

  it('reads the last saved entry when one tab somehow has two', () => {
    mockSaved = [
      { tab: QUEUE_ID, ...placement({ pages: ['*'] }, {}) },
      { tab: QUEUE_ID, ...placement({ rooms: ['room-2'] }, {}) },
    ];
    renderSection();
    expect(screen.getByRole('button', { name: 'Remove #ops' })).toBeInTheDocument();
  });

  it('shows no "Hidden in" row when nothing is hidden', () => {
    renderSection();
    expect(screen.queryByText('Hidden in')).not.toBeInTheDocument();
  });

  it('offers "Use its default" only with a saved choice and a declared default, and drops the choice', () => {
    mockContributions = [tab(QUEUE_ID, 'Queue', placement({ rooms: ['room-1'] }))];
    mockSaved = [{ tab: QUEUE_ID, ...placement({ rooms: ['room-2'] }) }];
    renderSection();

    fireEvent.click(screen.getByRole('button', { name: 'Use its default' }));

    expect(mockSetPlacement).toHaveBeenCalledWith(QUEUE_ID, null);
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('offers no reset at all without a saved choice', () => {
    mockContributions = [tab(QUEUE_ID, 'Queue', placement({ rooms: ['room-1'] }))];
    renderSection();
    expect(screen.queryByRole('button', { name: 'Use its default' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
  });

  it('calls it "Reset" when the tab declared no default', () => {
    mockSaved = [{ tab: QUEUE_ID, ...placement({ rooms: ['room-2'] }) }];
    renderSection();
    expect(screen.queryByRole('button', { name: 'Use its default' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
    expect(mockSetPlacement).toHaveBeenCalledWith(QUEUE_ID, null);
  });

  it('labels each editor with its tab when the mini app has two tabs', () => {
    mockContributions = [tab(QUEUE_ID, 'Queue'), tab('social-queue:drafts', 'Drafts')];
    renderSection();

    expect(screen.getByText('Queue tab shows')).toBeInTheDocument();
    expect(screen.getByText('Drafts tab shows')).toBeInTheDocument();
    expect(screen.queryByText('Panel tab shows')).not.toBeInTheDocument();
    expect(
      screen.getByRole('radiogroup', { name: 'Where the Drafts tab shows' })
    ).toBeInTheDocument();

    const drafts = screen.getByTestId('panel-tab-placement-social-queue:drafts');
    fireEvent.click(within(drafts).getByRole('radio', { name: 'Only in…' }));
    expect(mockSetPlacement).toHaveBeenCalledWith('social-queue:drafts', placement({}));
  });
});
