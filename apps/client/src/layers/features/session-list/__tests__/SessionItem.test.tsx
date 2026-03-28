import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionItem } from '../ui/SessionItem';
import type { Session } from '@dorkos/shared/types';
import { useSessionChatStore } from '@/layers/entities/session';

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

describe('SessionItem', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('renders session title', () => {
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    expect(screen.getByText('Test conversation')).toBeDefined();
  });

  it('renders relative time from updatedAt', () => {
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    // updatedAt is 1 hour before NOW
    expect(screen.getByText('1h ago')).toBeDefined();
  });

  it('shows active session with left border', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    const item = container.firstChild as HTMLElement;
    expect(item.className).toContain('border-primary');
  });

  it('calls onClick when clicked', () => {
    const onClick = vi.fn();
    render(<SessionItem session={makeSession()} isActive={false} onClick={onClick} />);
    fireEvent.click(screen.getByText('Test conversation'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders layoutId active background when isActive', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    // The layoutId motion.div (rendered as plain div by mock) has class bg-secondary
    const bg = container.querySelector('.bg-secondary');
    expect(bg).not.toBeNull();
  });

  it('does not render layoutId active background when not active', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const bg = container.querySelector('.bg-secondary');
    expect(bg).toBeNull();
  });

  it('renders layoutId background element when isActive', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    // The layoutId motion.div renders as a plain div under the mock
    // It should have the absolute inset-0 bg-secondary classes
    const bg = container.querySelector('.absolute.inset-0.bg-secondary');
    expect(bg).not.toBeNull();
  });

  it('does not render layoutId background element when not active', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const bg = container.querySelector('.absolute.inset-0.bg-secondary');
    expect(bg).toBeNull();
  });

  it('clickable surface is rendered with relative z-10 classes', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const clickable = container.querySelector('[role="button"]');
    expect(clickable).not.toBeNull();
    expect(clickable!.className).toContain('relative');
    expect(clickable!.className).toContain('z-10');
  });

  it('shows permission warning for bypassPermissions mode', () => {
    const { container } = render(
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
    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const warning = container.querySelector('.text-red-500');
    expect(warning).toBeNull();
  });

  it('does not render preview text', () => {
    render(
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
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    expect(screen.queryByText('Session ID')).toBeNull();
  });

  it('shows details panel when ellipsis button is clicked', () => {
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    const detailsBtn = screen.getByLabelText('Session details');
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Session ID')).toBeDefined();
    expect(screen.getByText('abc12345-def6-7890-abcd-ef1234567890')).toBeDefined();
  });

  it('shows timestamps in details panel', () => {
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByText('Created')).toBeDefined();
    expect(screen.getByText('Updated')).toBeDefined();
  });

  it('shows permission mode in details panel', () => {
    render(
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
    render(<SessionItem session={makeSession()} isActive={false} onClick={onClick} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('hides details panel when ellipsis is clicked again', () => {
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    const detailsBtn = screen.getByLabelText('Session details');
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Session ID')).toBeDefined();
    fireEvent.click(detailsBtn);
    expect(screen.queryByText('Session ID')).toBeNull();
  });

  it('renders copy button for session ID', () => {
    render(<SessionItem session={makeSession()} isActive={false} onClick={() => {}} />);
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByLabelText('Copy Session ID')).toBeDefined();
  });
});

describe('SessionActivityIndicator', () => {
  const SESSION_ID = 'abc12345-def6-7890-abcd-ef1234567890';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    // Reset store so state doesn't leak between tests
    useSessionChatStore.setState({ sessions: {}, sessionAccessOrder: [] });
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('shows no indicator when session is idle with no unseen activity', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    // No colored dot should be present
    expect(container.querySelector('[aria-label="Streaming"]')).toBeNull();
    expect(container.querySelector('[aria-label="Error"]')).toBeNull();
    expect(container.querySelector('[aria-label="New activity"]')).toBeNull();
    expect(container.querySelector('[aria-label="Waiting for approval"]')).toBeNull();
  });

  it('shows green pulsing dot when session is streaming', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { status: 'streaming' });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const dot = container.querySelector('[aria-label="Streaming"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-green-500');
    expect(dot!.className).toContain('animate-pulse');
  });

  it('shows red dot when session has an error', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { status: 'error' });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const dot = container.querySelector('[aria-label="Error"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-destructive');
  });

  it('shows blue dot when session has unseen activity', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, {
      status: 'idle',
      hasUnseenActivity: true,
    });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const dot = container.querySelector('[aria-label="New activity"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-blue-500');
  });

  it('shows amber pulsing dot when session has a pending tool approval', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, {
      status: 'streaming',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          parts: [],
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              toolCallId: 'tc-1',
              toolName: 'Bash',
              input: 'rm -rf /',
              status: 'pending',
              interactiveType: 'approval',
            },
          ],
        },
      ],
    });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const dot = container.querySelector('[aria-label="Waiting for approval"]');
    expect(dot).not.toBeNull();
    expect(dot!.className).toContain('bg-amber-500');
    expect(dot!.className).toContain('animate-pulse');
  });

  it('pending approval dot takes priority over streaming dot', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, {
      status: 'streaming',
      messages: [
        {
          id: 'msg-1',
          role: 'assistant',
          content: '',
          parts: [],
          timestamp: new Date().toISOString(),
          toolCalls: [
            {
              toolCallId: 'tc-1',
              toolName: 'Bash',
              input: 'ls',
              status: 'pending',
              interactiveType: 'approval',
            },
          ],
        },
      ],
    });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    expect(container.querySelector('[aria-label="Waiting for approval"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Streaming"]')).toBeNull();
  });

  it('shows no indicator for the active session even when streaming', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { status: 'streaming' });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    expect(container.querySelector('[aria-label="Streaming"]')).toBeNull();
  });

  it('shows no indicator for the active session even with unseen activity', () => {
    useSessionChatStore.getState().updateSession(SESSION_ID, { hasUnseenActivity: true });

    const { container } = render(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    expect(container.querySelector('[aria-label="New activity"]')).toBeNull();
  });
});
