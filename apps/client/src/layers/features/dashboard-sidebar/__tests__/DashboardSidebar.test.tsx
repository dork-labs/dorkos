// @vitest-environment jsdom
import { describe, it, expect, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardSidebar } from '../ui/DashboardSidebar';
import { SidebarProvider, TooltipProvider } from '@/layers/shared/ui';

// Mock TanStack Router
const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
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

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <SidebarProvider>{ui}</SidebarProvider>
      </TooltipProvider>
    </QueryClientProvider>
  );
}

describe('DashboardSidebar', () => {
  it('renders Dashboard nav item', () => {
    renderWithProviders(<DashboardSidebar />);
    // getAllByText handles SidebarProvider rendering both desktop and mobile variants
    const items = screen.getAllByText('Dashboard');
    expect(items.length).toBeGreaterThanOrEqual(1);
  });

  it('renders Sessions nav item that navigates to /session', () => {
    renderWithProviders(<DashboardSidebar />);
    const sessionsButtons = screen.getAllByText('Sessions');
    expect(sessionsButtons.length).toBeGreaterThanOrEqual(1);

    // Click the first Sessions button
    fireEvent.click(sessionsButtons[0]);
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/session' });
  });

  it('shows placeholder content', () => {
    renderWithProviders(<DashboardSidebar />);
    // getAllByText handles SidebarProvider rendering both desktop and mobile variants
    const placeholders = screen.getAllByText('Agent overview coming soon');
    expect(placeholders.length).toBeGreaterThanOrEqual(1);
  });

  it('does not render SidebarFooterBar (footer is in AppShell)', () => {
    renderWithProviders(<DashboardSidebar />);
    // SidebarFooterBar renders a settings button; it should not be present inside DashboardSidebar
    expect(screen.queryByLabelText('Settings')).not.toBeInTheDocument();
  });
});
