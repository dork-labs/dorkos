// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { SidebarPrefs } from '@dorkos/shared/config-schema';
import { UngroupedSectionMenu } from '../ui/UngroupedSectionMenu';

const mockUpdate = vi.fn<(updater: (prev: SidebarPrefs) => SidebarPrefs) => void>();
const helperCalls: { name: string; args: unknown[] }[] = [];

const PREFS = {
  pinned: [],
  groups: [],
  ungroupedSortMode: 'name',
  ungroupedCollapsed: false,
  recentsCollapsed: false,
  groupsHintDismissed: false,
  muted: [],
  ungroupedDisplayFilter: 'all',
} as SidebarPrefs;

vi.mock('@/layers/entities/config', () => ({
  useSidebarPrefs: () => PREFS,
  useUpdateSidebarPrefs: () => ({
    update: mockUpdate,
    updateAsync: vi.fn(),
    isPending: false,
    isError: false,
  }),
  setUngroupedDisplayFilter: (...args: unknown[]) => {
    helperCalls.push({ name: 'setUngroupedDisplayFilter', args });
    return args[0];
  },
}));

beforeAll(() => {
  global.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
});

afterEach(() => cleanup());

beforeEach(() => {
  mockUpdate.mockReset();
  helperCalls.length = 0;
});

function applyLatestUpdater() {
  const updater = mockUpdate.mock.calls.at(-1)?.[0];
  if (!updater) throw new Error('no update committed');
  helperCalls.length = 0;
  updater(PREFS);
  return helperCalls;
}

describe('UngroupedSectionMenu', () => {
  it('renders a "Show" submenu with the three filter options', () => {
    render(<UngroupedSectionMenu />);
    fireEvent.pointerDown(screen.getByLabelText('Agents section actions'));
    fireEvent.click(screen.getByLabelText('Agents section actions'));
    expect(screen.getByText('Show')).toBeInTheDocument();
  });

  it('selecting a filter calls setUngroupedDisplayFilter with the chosen value', () => {
    render(<UngroupedSectionMenu />);
    fireEvent.pointerDown(screen.getByLabelText('Agents section actions'));
    fireEvent.click(screen.getByLabelText('Agents section actions'));
    const subTrigger = screen.getByText('Show');
    fireEvent.keyDown(subTrigger, { key: 'ArrowRight' });
    fireEvent.click(screen.getByText('Active'));

    const calls = applyLatestUpdater();
    expect(calls).toEqual([{ name: 'setUngroupedDisplayFilter', args: [PREFS, 'active'] }]);
  });
});
