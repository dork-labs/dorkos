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
const mockImportOpen = vi.fn();
const mockNavigate = vi.fn();

vi.mock('@/layers/shared/model', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/layers/shared/model')>();
  return {
    ...actual,
    useAgentCreationStore: Object.assign(() => ({}), {
      getState: () => ({ open: mockOpen }),
    }),
    useImportProjectsStore: Object.assign(() => ({}), {
      getState: () => ({ open: mockImportOpen }),
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

function renderMenu(props: Parameters<typeof AddAgentMenu>[0] = {}) {
  return render(
    <TooltipProvider>
      <SidebarProvider>
        <SidebarGroup>
          <SidebarGroupLabel>Agents</SidebarGroupLabel>
          <AddAgentMenu {...props} />
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
    mockImportOpen.mockReset();
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
    expect(screen.getByText('Bring in a project')).toBeInTheDocument();
    expect(screen.getByText('Browse Marketplace')).toBeInTheDocument();
  });

  it('Create agent opens creation dialog on default tab', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Create agent'));
    expect(mockOpen).toHaveBeenCalledWith();
  });

  it('Bring in a project opens the standalone import dialog', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Bring in a project'));
    expect(mockImportOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen).not.toHaveBeenCalled();
  });

  it('Browse Marketplace navigates to /marketplace', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('Browse Marketplace'));
    expect(mockNavigate).toHaveBeenCalledWith({ to: '/marketplace' });
  });

  it('hides the New group entry when onNewGroup is not provided', () => {
    renderMenu();
    fireEvent.click(screen.getByLabelText('Add agent'));
    expect(screen.queryByText('New group')).not.toBeInTheDocument();
  });

  it('New group opens the inline create flow (DOR-329 entry point)', () => {
    const onNewGroup = vi.fn();
    renderMenu({ onNewGroup });
    fireEvent.click(screen.getByLabelText('Add agent'));
    fireEvent.click(screen.getByText('New group'));
    expect(onNewGroup).toHaveBeenCalledOnce();
    // The popover closes after selection.
    expect(screen.queryByText('Create agent')).not.toBeInTheDocument();
  });
});
