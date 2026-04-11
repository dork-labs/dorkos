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

const mockSetAgentDialogOpen = vi.fn();
const mockSetPickerOpen = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAppStore: (selector: (s: Record<string, unknown>) => unknown) => {
      return selector({
        setAgentDialogOpen: mockSetAgentDialogOpen,
        setPickerOpen: mockSetPickerOpen,
      });
    },
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
    mockSetAgentDialogOpen.mockReset();
    mockSetPickerOpen.mockReset();
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

  it('Create agent calls setAgentDialogOpen(true)', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Create agent'));
    expect(mockSetAgentDialogOpen).toHaveBeenCalledWith(true);
  });

  it('Import project calls setPickerOpen(true)', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Import project'));
    expect(mockSetPickerOpen).toHaveBeenCalledWith(true);
  });

  it('Browse Dork Hub navigates to /marketplace', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Browse Dork Hub'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/marketplace' });
  });
});
