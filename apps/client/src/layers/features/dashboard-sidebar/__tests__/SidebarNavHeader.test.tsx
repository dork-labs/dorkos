/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SidebarProvider } from '@/layers/shared/ui';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { SidebarNavHeader } from '../ui/SidebarNavHeader';

/** The pathname the mocked router reports. Set it before rendering. */
let mockPathname = '/';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  // Faithful to the real hook: the component passes a selector over router
  // state, so the mock runs it against a location the test controls.
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) =>
    select({ location: { pathname: mockPathname } }),
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

afterEach(() => {
  cleanup();
  mockPathname = '/';
});

function renderNavAt(pathname: string) {
  mockPathname = pathname;
  return render(
    <SidebarProvider>
      <SidebarNavHeader />
    </SidebarProvider>
  );
}

/** True when the nav button with this name is drawn as the current place. */
function isActive(name: string): boolean {
  return screen.getByRole('button', { name }).getAttribute('data-active') === 'true';
}

describe('SidebarNavHeader', () => {
  it('offers four places to go, plus Search', () => {
    renderNavAt('/');

    const names = screen
      .getAllByRole('button')
      .map((button) => button.textContent?.replace(/\s+/g, ' ').trim() ?? '');

    // The four nav rows are matched exactly and in order; Search comes last and
    // is matched loosely, because its button also carries the shortcut key.
    expect(names.slice(0, 4)).toEqual(['Home', 'Team', 'Connections', 'Marketplace']);
    expect(names).toHaveLength(5);
    expect(names[4]).toMatch(/^Search/);
  });

  it('no longer offers Activity, Tasks or Workspaces (they are tabs of Home now)', () => {
    renderNavAt('/');

    expect(screen.queryByRole('button', { name: 'Activity' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tasks' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Workspaces' })).toBeNull();
  });

  it.each(['/', '/activity', '/tasks', '/workspaces'])(
    'reads Home as the current place on %s',
    (pathname) => {
      renderNavAt(pathname);

      expect(isActive('Home')).toBe(true);
    }
  );

  it.each(['/Activity/', '/TASKS', '//'])(
    'reads Home as the current place on %s, however the address was spelled',
    (pathname) => {
      renderNavAt(pathname);

      expect(isActive('Home')).toBe(true);
    }
  );

  it('hands the current place to Team when Team is open', () => {
    renderNavAt('/team');

    expect(isActive('Home')).toBe(false);
    expect(isActive('Team')).toBe(true);
  });

  it('keeps Marketplace current on its nested pages', () => {
    renderNavAt('/marketplace/sources');

    expect(isActive('Marketplace')).toBe(true);
    expect(isActive('Home')).toBe(false);
  });

  // The e2e specs click this one; no tour points into the sidebar any more,
  // because on a phone it is a sheet that is unmounted until you open it.
  it('stamps the Team nav anchor the e2e specs click', () => {
    renderNavAt('/');

    expect(screen.getByTestId(TOUR_ANCHORS.navAgents)).toHaveTextContent('Team');
  });
});
