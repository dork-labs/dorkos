import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SessionItem } from '../ui/SessionItem';
import type { Session } from '@dorkos/shared/types';

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

// Mock motion/react to render plain elements
vi.mock('motion/react', () => ({
  motion: {
    div: ({ children, initial, animate, exit, transition, ...props }: Record<string, unknown>) => {
      void initial; void animate; void exit; void transition;
      const { className, style, ...rest } = props as Record<string, unknown>;
      return <div className={className as string} style={style as React.CSSProperties} {...rest}>{children as React.ReactNode}</div>;
    },
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

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
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    expect(screen.getByText('Test conversation')).toBeDefined();
  });

  it('renders relative time from updatedAt', () => {
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
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
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={onClick} />
    );
    fireEvent.click(screen.getByText('Test conversation'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('applies active styling when isActive', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={true} onClick={() => {}} />
    );
    const item = container.firstChild as HTMLElement;
    expect(item.className).toContain('bg-secondary');
  });

  it('applies hover styling when not active', () => {
    const { container } = render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const item = container.firstChild as HTMLElement;
    expect(item.className).toContain('hover:bg-secondary/50');
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
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    expect(screen.queryByText('Session ID')).toBeNull();
  });

  it('shows details panel when ellipsis button is clicked', () => {
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const detailsBtn = screen.getByLabelText('Session details');
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Session ID')).toBeDefined();
    expect(screen.getByText('abc12345-def6-7890-abcd-ef1234567890')).toBeDefined();
  });

  it('shows timestamps in details panel', () => {
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
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
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={onClick} />
    );
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('hides details panel when ellipsis is clicked again', () => {
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    const detailsBtn = screen.getByLabelText('Session details');
    fireEvent.click(detailsBtn);
    expect(screen.getByText('Session ID')).toBeDefined();
    fireEvent.click(detailsBtn);
    expect(screen.queryByText('Session ID')).toBeNull();
  });

  it('renders copy button for session ID', () => {
    render(
      <SessionItem session={makeSession()} isActive={false} onClick={() => {}} />
    );
    fireEvent.click(screen.getByLabelText('Session details'));
    expect(screen.getByLabelText('Copy Session ID')).toBeDefined();
  });
});
