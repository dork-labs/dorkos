/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
}));

const mockUseSessions = vi.fn();
vi.mock('@/layers/entities/session', () => ({
  useSessions: () => mockUseSessions(),
}));

// ---------------------------------------------------------------------------
// Import component after mocks
// ---------------------------------------------------------------------------

import { SessionLaunchPopover } from '../ui/SessionLaunchPopover';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const projectPath = '/home/user/projects/frontend';

const makeSessions = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    // Use UUID-style IDs so slice(0, 8) produces unique, readable truncated text
    id: `abcdef${String(i + 1).padStart(2, '0')}-1234-5678-9abc-def012345678`,
    cwd: projectPath,
    title: `Session ${i + 1}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    lastMessagePreview: `Last message ${i + 1}`,
  }));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

afterEach(cleanup);

describe('SessionLaunchPopover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseSessions.mockReturnValue({ sessions: [], isLoading: false });
  });

  it('renders Start Session button when no active sessions', () => {
    mockUseSessions.mockReturnValue({ sessions: [], isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} />);

    expect(screen.getByRole('button', { name: /start session/i })).toBeInTheDocument();
  });

  it('navigates to /session with dir param on Start Session click', () => {
    mockUseSessions.mockReturnValue({ sessions: [], isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} />);

    fireEvent.click(screen.getByRole('button', { name: /start session/i }));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: projectPath },
    });
  });

  it('renders Open Session button with badge when sessions exist', () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(2), isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} />);

    expect(screen.getByRole('button', { name: /open session/i })).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('shows session list in popover when Open Session is clicked', () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(2), isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));

    // Session IDs truncated to 8 chars — "abcdef01" from "abcdef01-1234-..."
    expect(screen.getByText(/abcdef01/i)).toBeInTheDocument();
  });

  it('navigates to /session with session param on session row click', () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(1), isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));

    // Click the session row via truncated ID text
    const sessionRow = screen.getByText(/abcdef01/i).closest('button') as HTMLElement;
    fireEvent.click(sessionRow);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'abcdef01-1234-5678-9abc-def012345678' },
    });
  });

  it('navigates to /session with dir param on New Session click', () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(1), isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));

    const newSessionBtn = screen.getByRole('button', { name: /new session/i });
    fireEvent.click(newSessionBtn);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: projectPath },
    });
  });

  it("carries the agent's runtime as the launch param on Start Session click", () => {
    mockUseSessions.mockReturnValue({ sessions: [], isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="opencode" />);

    fireEvent.click(screen.getByRole('button', { name: /start session/i }));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: projectPath, runtime: 'opencode' },
    });
  });

  it("carries the agent's runtime as the launch param on New Session click", () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(1), isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="codex" />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));
    fireEvent.click(screen.getByRole('button', { name: /new session/i }));

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: projectPath, runtime: 'codex' },
    });
  });

  it('does not attach the runtime param when opening an existing session', () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(1), isLoading: false });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="opencode" />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));
    const sessionRow = screen.getByText(/abcdef01/i).closest('button') as HTMLElement;
    fireEvent.click(sessionRow);

    // An existing session's runtime is immutable — a launch hint would be noise.
    const call = mockNavigate.mock.calls.at(-1)?.[0] as { search: Record<string, unknown> };
    expect(call.search).toEqual({ session: 'abcdef01-1234-5678-9abc-def012345678' });
    expect(call.search).not.toHaveProperty('runtime');
  });
});
