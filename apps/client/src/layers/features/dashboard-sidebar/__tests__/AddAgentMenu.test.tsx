/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AddAgentMenu } from '../ui/AddAgentMenu';
import {
  SidebarProvider,
  SidebarGroup,
  SidebarGroupLabel,
  TooltipProvider,
} from '@/layers/shared/ui';

const mockOpen = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: Object.assign(() => ({}), {
      getState: () => ({ open: mockOpen }),
    }),
  };
});

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
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

function renderMenu() {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <AddAgentMenu />
        </SidebarGroup>
      </SidebarProvider>
    </TooltipProvider>
  );
}

describe('AddAgentMenu', () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    mockOpen.mockReset();
    mockNavigate.mockReset();
  });

  it('renders + button with aria-label', () => {
    renderMenu();
    expect(screen.getByLabelText('Add agent')).toBeInTheDocument();
  });

  it('opens popover on click showing three actions', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    expect(screen.getByText('Create agent')).toBeInTheDocument();
    expect(screen.getByText('Import project')).toBeInTheDocument();
    expect(screen.getByText('Browse Dork Hub')).toBeInTheDocument();
  });

  it('Create agent opens creation dialog on default tab', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Create agent'));
    expect(mockOpen).toHaveBeenCalledWith();
  });

  it('Import project opens creation dialog on import tab', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Import project'));
    expect(mockOpen).toHaveBeenCalledWith('import');
  });

  it('Browse Dork Hub navigates to /marketplace', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Browse Dork Hub'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/marketplace' });
  });
});
