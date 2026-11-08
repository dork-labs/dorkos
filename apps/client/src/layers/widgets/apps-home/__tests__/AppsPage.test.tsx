// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';

const catalog = vi.hoisted(() => ({ value: undefined as unknown }));
const actions = vi.hoisted(() => ({
  open: vi.fn(),
  openInNewTab: vi.fn(),
  openSettings: vi.fn(),
  tryAgain: vi.fn(),
  setOn: vi.fn(),
}));
const pins = vi.hoisted(() => ({ pin: vi.fn(), unpin: vi.fn(), setPins: vi.fn() }));
const retry = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const navigate = vi.hoisted(() => vi.fn());
const mobile = vi.hoisted(() => ({ value: false }));

vi.mock('@/layers/entities/extension', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/extension')>()),
  useAppCatalog: () => catalog.value,
  useAppActions: () => actions,
  useAppPins: () => pins,
  useAppTrying: () => false,
  useRetryApps: () => retry,
}));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
}));
vi.mock('@/layers/shared/model', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/shared/model')>()),
  useIsMobile: () => mobile.value,
}));

import { AppsPage } from '../ui/AppsPage';

/** One app as the catalog answers it. */
function app(id: string, name: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    name,
    summary: '',
    state: 'ok',
    path: '',
    pageId: `${id}:`,
    count: 0,
    line: null,
    ...overrides,
  };
}

/** Set what the catalog answers. */
function given(apps: ReturnType<typeof app>[], pinIds: string[] = [], status = 'ready') {
  const byId = new Map(apps.map((entry) => [entry.id, entry]));
  catalog.value = {
    status,
    apps,
    pins: pinIds,
    pinned: pinIds.flatMap((id) => (byId.has(id) ? [byId.get(id)] : [])),
  };
}

/** The tile names in a group, in order. */
function tilesIn(group: string): string[] {
  return within(screen.getByRole('region', { name: group }))
    .getAllByTestId(/^apps-tile-/)
    .map((tile) => tile.getAttribute('data-testid')!.replace('apps-tile-', ''));
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mobile.value = false;
});

describe('AppsPage', () => {
  it('puts pins first in pin order, then everything else A–Z with off apps last', () => {
    given(
      [
        app('alpha', 'Alpha'),
        app('board', 'Board', { state: 'off' }),
        app('notes', 'Notes'),
        app('zeta', 'Zeta'),
      ],
      ['zeta', 'notes']
    );
    render(<AppsPage />);
    expect(tilesIn('Pinned')).toEqual(['zeta', 'notes']);
    expect(tilesIn('Everything else')).toEqual(['alpha', 'board']);
  });

  it('calls the one group "All apps" when nothing is pinned, and draws no Pinned group', () => {
    given([app('alpha', 'Alpha')]);
    render(<AppsPage />);
    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
    expect(tilesIn('All apps')).toEqual(['alpha']);
  });

  it('filters both groups as you type, says when nothing matches, and Esc clears', async () => {
    given([app('alpha', 'Alpha'), app('notes', 'Notes', { summary: 'keeps minutes' })], ['alpha']);
    render(<AppsPage />);
    const search = screen.getByTestId('apps-search');
    await userEvent.type(search, 'minutes');
    expect(screen.queryByRole('region', { name: 'Pinned' })).not.toBeInTheDocument();
    expect(tilesIn('Everything else')).toEqual(['notes']);

    await userEvent.clear(search);
    await userEvent.type(search, 'xyz');
    expect(screen.getByText('No apps match “xyz”.')).toBeInTheDocument();

    fireEvent.keyDown(search, { key: 'Escape' });
    expect(search).toHaveValue('');
  });

  it('focuses search on /', () => {
    given([app('alpha', 'Alpha')]);
    render(<AppsPage />);
    fireEvent.keyDown(window, { key: '/' });
    expect(screen.getByTestId('apps-search')).toHaveFocus();
  });

  it('names each tile with its state, and a press does what that state calls for', async () => {
    given([
      app('radar', 'Release Radar', { state: 'held' }),
      app('weather', 'Weather Desk', { state: 'error' }),
    ]);
    render(<AppsPage />);
    const held = screen.getByRole('button', { name: 'Release Radar, needs your OK' });
    expect(held).toHaveTextContent('Needs your OK');
    await userEvent.click(held);
    expect(actions.open).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'radar', state: 'held' })
    );

    const broken = screen.getByRole('button', { name: 'Weather Desk, not working. Try again' });
    expect(broken).toHaveTextContent('Not working');
  });

  it('shows the live line or nothing, never a description', () => {
    given([
      app('ts', 'Timesheet', { line: '2 entries to check', summary: 'Tracks hours you work.' }),
      app('plain', 'Plain', { summary: 'A long description nobody asked to see.' }),
    ]);
    render(<AppsPage />);
    expect(screen.getByTestId('apps-tile-ts')).toHaveTextContent('2 entries to check');
    expect(screen.getByTestId('apps-tile-plain')).toHaveTextContent(/^Plain$/);
  });

  // Purpose: an app's own count is news, not a warning: the neutral pill,
  // capped at 9+ (DOR-3077).
  it('draws an app’s count as a neutral pill, capped at 9+', () => {
    given([app('ts', 'Timesheet', { count: 2 }), app('mail', 'Mail', { count: 14 })]);
    render(<AppsPage />);
    const two = screen.getByTestId('apps-tile-ts').querySelector('[data-slot="count-pill"]');
    expect(two).toHaveAttribute('data-tone', 'neutral');
    expect(two).toHaveTextContent('2');
    const many = screen.getByTestId('apps-tile-mail').querySelector('[data-slot="count-pill"]');
    expect(many).toHaveAttribute('data-tone', 'neutral');
    expect(many).toHaveTextContent('9+');
  });

  it('says it couldn’t load, never "no apps", and tries again', async () => {
    given([], ['alpha'], 'failed');
    render(<AppsPage />);
    expect(screen.queryByText('No apps yet')).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('Couldn’t load apps');
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(retry).toHaveBeenCalledTimes(1);
  });

  it('says "No apps yet" only once the server answered with none, and offers Get apps', async () => {
    given([], [], 'loading');
    const { unmount } = render(<AppsPage />);
    expect(screen.queryByText('No apps yet')).not.toBeInTheDocument();
    unmount();

    given([]);
    render(<AppsPage />);
    expect(screen.getByText('No apps yet')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: /Get apps/ }).at(-1)!);
    expect(navigate).toHaveBeenCalledWith(
      expect.objectContaining({ to: '/marketplace', search: { type: 'plugin' } })
    );
  });

  it('draws rows on a phone, with no visible ⋮', () => {
    mobile.value = true;
    given([app('alpha', 'Alpha')]);
    render(<AppsPage />);
    const actionsButton = screen.getByRole('button', { name: 'Alpha actions', hidden: true });
    expect(actionsButton).toHaveAttribute('tabindex', '-1');
  });
});
