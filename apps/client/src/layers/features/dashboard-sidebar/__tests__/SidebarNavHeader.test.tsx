/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { SidebarProvider } from '@/layers/shared/ui';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import { SidebarNavHeader } from '../ui/SidebarNavHeader';

vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
  useRouterState: () => '/',
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
});

function renderNav() {
  return render(
    <SidebarProvider>
      <SidebarNavHeader />
    </SidebarProvider>
  );
}

describe('SidebarNavHeader', () => {
  it('stamps the Agents nav tour anchor', () => {
    renderNav();
    expect(screen.getByTestId(TOUR_ANCHORS.navAgents)).toBeInTheDocument();
  });

  it('stamps the Tasks nav tour anchor', () => {
    renderNav();
    expect(screen.getByTestId(TOUR_ANCHORS.navTasks)).toBeInTheDocument();
  });
});
