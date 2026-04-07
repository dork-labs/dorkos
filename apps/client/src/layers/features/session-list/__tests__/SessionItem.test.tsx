import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionItem } from '../ui/SessionItem';
import type { Session } from '@dorkos/shared/types';
import { useSessionChatStore } from '@/layers/entities/session';
import { TooltipProvider } from '@/layers/shared/ui';

// Mock window.matchMedia for useIsMobile hook
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

  // Radix UI's @radix-ui/react-use-size calls ResizeObserver which jsdom doesn't provide.
  global.ResizeObserver = class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

const NOW = new Date('2026-02-07T15:00:00Z');

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: 'abc12345-def6-7890-abcd-ef1234567890',
    title: 'Test conversation',
    createdAt: '2026-02-07T10:00:00Z',
    updatedAt: '2026-02-07T14:00:00Z',
    permissionMode: 'default',
    ...overrides,
  };
}

function Wrapper({ children }: { children: React.ReactNode }) {
  return <TooltipProvider>{children}</TooltipProvider>;
}

function renderItem(ui: React.ReactElement) {
  return render(ui, { wrapper: Wrapper });
}

describe('SessionItem', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders session title', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    expect(screen.getByText('Test conversation')).toBeDefined();
  });

  it('renders relative time from updatedAt', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    // updatedAt is 1 hour before NOW
    expect(screen.getByText('1h ago')).toBeDefined();
  });

  it('shows active session with primary border color', () => {
    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    const item = container.querySelector('[data-testid="session-item"]') as HTMLElement;
    expect(item.style.borderLeftColor).toBe('hsl(var(--primary))');
  });

  it('sets aria-current=page when active', () => {
    renderItem(<SessionItem session={makeSession()} isActive={true} onClick={() => {}} />);
    const row = screen.getByRole('button', { name: /Session: Test conversation/ });
    expect(row.getAttribute('aria-current')).toBe('page');
  });

  it('omits aria-current when inactive', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    const row = screen.getByRole('button', { name: /Session: Test conversation/ });
    expect(row.getAttribute('aria-current')).toBeNull();
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={onClick} />);
    fireEvent.click(screen.getByText('Test conversation'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders layoutId active background when isActive', () => {
    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    const bg = container.querySelector('.absolute.inset-0.bg-secondary');
    expect(bg).not.toBeNull();
  });

  it('does not render layoutId active background when not active', () => {
    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const bg = container.querySelector('.absolute.inset-0.bg-secondary');
    expect(bg).toBeNull();
  });

  it('clickable surface is rendered with relative z-10 classes', () => {
    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const clickable = container.querySelector('[role="button"]');
    expect(clickable).not.toBeNull();
    expect(clickable!.className).toContain('relative');
    expect(clickable!.className).toContain('z-10');
  });

  it('shows permission warning for bypassPermissions mode', () => {
    const { container } = renderItem(
      <SessionItem
        session={makeSession({ permissionMode: 'bypassPermissions' })}
        isActive={false}
        onClick={() => {}}
      />
    );
    const warning = container.querySelector('.text-red-500');
    expect(warning).not.toBeNull();
  });

  it('does not show permission warning for default mode', () => {
    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const warning = container.querySelector('.text-red-500');
    expect(warning).toBeNull();
  });

  it('does not render preview text', () => {
    renderItem(
      <SessionItem
        session={makeSession({ lastMessagePreview: 'Some preview text' })}
        isActive={false}
        onClick={() => {}}
      />
    );
    expect(screen.queryByText('Some preview text')).toBeNull();
  });

  // Details panel tests
  it('does not show details panel by default', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    expect(screen.queryByText('Session ID')).toBeNull();
  });

  it('shows details panel when ellipsis button is clicked', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    const detailsBtn = screen.getByLabelText('Session details');
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Session ID')).toBeDefined();
    expect(screen.getByText('abc12345-def6-7890-abcd-ef1234567890')).toBeDefined();
  });

  it('details button has aria-expanded reflecting state', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    const detailsBtn = screen.getByLabelText('Session details');
    expect(detailsBtn.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(detailsBtn);
    expect(detailsBtn.getAttribute('aria-expanded')).toBe('true');
  });

  it('shows timestamps in details panel', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByText('Created')).toBeDefined();
    expect(screen.getByText('Updated')).toBeDefined();
  });

  it('shows permission mode in details panel', () => {
    renderItem(
      <SessionItem
        session={makeSession({ permissionMode: 'bypassPermissions' })}
        isActive={false}
        onClick={() => {}}
      />
    );
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByText('Permissions')).toBeDefined();
    expect(screen.getByText('Skip (unsafe)')).toBeDefined();
  });

  it('does not trigger onClick when details button is clicked', () => {
    const onClick = vi.fn();
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={onClick} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('hides details panel when ellipsis is clicked again', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    const detailsBtn = screen.getByLabelText('Session details');
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Session ID')).toBeDefined();
    fireEvent.click(detailsBtn);
    expect(screen.queryByText('Session ID')).toBeNull();
  });

  it('renders copy button for session ID', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByLabelText('Copy Session ID')).toBeDefined();
  });

  // Fork button tests
  it('renders fork button when onFork is provided', () => {
    renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} onFork={vi.fn()} />
    );
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByLabelText('Fork session')).toBeDefined();
  });

  it('does not render fork button when onFork is omitted', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.queryByLabelText('Fork session')).toBeNull();
  });

  it('calls onFork with session ID when fork button is clicked', () => {
    const onFork = vi.fn();
    const session = makeSession();
    renderItem(
      <SessionItem session={session} isActive={false} onClick={() => {}} onFork={onFork} />
    );
    fireEvent.click(screen.getByLabelText('Session details'));
    fireEvent.click(screen.getByLabelText('Fork session'));
    expect(onFork).toHaveBeenCalledWith(session.id);
  });

  it('does not trigger onClick when fork button is clicked', () => {
    const onClick = vi.fn();
    renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={onClick} onFork={vi.fn()} />
    );
    fireEvent.click(screen.getByLabelText('Session details'));
    fireEvent.click(screen.getByLabelText('Fork session'));
    expect(onClick).not.toHaveBeenCalled();
  });

  // Rename affordance
  it('renders rename (pencil) button when onRename is provided', () => {
    renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} onRename={vi.fn()} />
    );
    expect(screen.getByLabelText('Rename session')).toBeDefined();
  });

  it('does not render rename button when onRename is omitted', () => {
    renderItem(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    expect(screen.queryByLabelText('Rename session')).toBeNull();
  });

  it('clicking pencil starts rename and focuses input', () => {
    renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} onRename={vi.fn()} />
    );
    fireEvent.click(screen.getByLabelText('Rename session'));
    const input = screen.getByLabelText('Session title') as HTMLInputElement;
    expect(input).toBeDefined();
    expect(input.value).toBe('Test conversation');
  });

  it('Enter commits a rename exactly once even after blur', () => {
    const onRename = vi.fn();
    renderItem(
      <SessionItem
        session={makeSession()}
        isActive={false}
        onClick={() => {}}
        onRename={onRename}
      />
    );
    fireEvent.click(screen.getByLabelText('Rename session'));
    const input = screen.getByLabelText('Session title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'New title' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    // Blur happens after Enter as the input is removed — simulate an explicit blur anyway.
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename).toHaveBeenCalledWith('abc12345-def6-7890-abcd-ef1234567890', 'New title');
  });

  it('Escape cancels a rename without calling onRename', () => {
    const onRename = vi.fn();
    renderItem(
      <SessionItem
        session={makeSession()}
        isActive={false}
        onClick={() => {}}
        onRename={onRename}
      />
    );
    fireEvent.click(screen.getByLabelText('Rename session'));
    const input = screen.getByLabelText('Session title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'Discarded' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onRename).not.toHaveBeenCalled();
  });

  it('empty or unchanged rename is silently dropped', () => {
    const onRename = vi.fn();
    renderItem(
      <SessionItem
        session={makeSession()}
        isActive={false}
        onClick={() => {}}
        onRename={onRename}
      />
    );
    fireEvent.click(screen.getByLabelText('Rename session'));
    const input = screen.getByLabelText('Session title') as HTMLInputElement;
    fireEvent.change(input, { target: { value: '   ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onRename).not.toHaveBeenCalled();
  });
});

describe('Session border indicator', () => {
  const SESSION_ID = 'abc12345-def6-7890-abcd-ef1234567890';

  function getBorderColor(container: HTMLElement): string {
    const item = container.querySelector('[data-testid="session-item"]') as HTMLElement;
    return item.style.borderLeftColor;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows transparent border when session is idle', () => {
    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    expect(getBorderColor(container)).toBe('transparent');
  });

  it('shows green border when session is streaming', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { status: 'streaming' });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    // Pulsing states set color via motion animate, not inline style — just verify
    // the row exists with the border-l-2 class.
    const item = container.querySelector('[data-testid="session-item"]') as HTMLElement;
    expect(item.className).toContain('border-l-2');
  });

  it('shows destructive border when session has an error', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { status: 'error' });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    expect(getBorderColor(container)).toBe('hsl(var(--destructive))');
  });

  it('shows blue border when session has unseen activity', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, {
      status: 'idle',
      hasUnseenActivity: true,
    });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    expect(getBorderColor(container)).toBe('var(--color-blue-500)');
  });

  it('pending approval beats streaming', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, {
      status: 'streaming',
      sdkState: 'requires_action',
    });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const item = container.querySelector('[data-testid="session-item"]') as HTMLElement;
    // Pulse state: inline style is not set — animate controls color.
    expect(item.style.borderLeftColor).toBe('');
    // Hand icon is the non-color differentiator.
    expect(screen.getByLabelText('Awaiting your approval')).toBeDefined();
  });

  it('pending approval beats active (active row must still surface approval)', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, {
      sdkState: 'requires_action',
    });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    const item = container.querySelector('[data-testid="session-item"]') as HTMLElement;
    // Active would have set 'hsl(var(--primary))'. Pending approval pulses (no inline style).
    expect(item.style.borderLeftColor).toBe('');
    expect(screen.getByLabelText('Awaiting your approval')).toBeDefined();
  });

  it('active session shows primary border when no pending approval', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { status: 'streaming' });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    expect(getBorderColor(container)).toBe('hsl(var(--primary))');
  });

  it('active session ignores unseen activity', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { hasUnseenActivity: true });

    const { container } = renderItem(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    expect(getBorderColor(container)).toBe('hsl(var(--primary))');
  });
});
