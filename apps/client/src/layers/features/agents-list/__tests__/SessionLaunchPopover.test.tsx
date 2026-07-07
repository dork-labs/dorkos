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

const mockUseRuntimeReadiness = vi.fn(
  (_type?: string): { registered: boolean; ready: boolean; unsatisfiedDeps: unknown[] } => ({
    registered: true,
    ready: true,
    unsatisfiedDeps: [],
  })
);
vi.mock('@/layers/entities/runtime', () => ({
  useRuntimeReadiness: (type?: string) => mockUseRuntimeReadiness(type),
  // The stub exposes a button that fires onRuntimeReady so tests can simulate a
  // connect succeeding without dialog internals.
  RuntimeSetupDialog: ({
    runtime,
    open,
    onRuntimeReady,
  }: {
    runtime?: string;
    open: boolean;
    onRuntimeReady?: (type: string) => void;
  }) =>
    open ? (
      <div data-testid="runtime-setup-dialog" data-runtime={runtime ?? ''}>
        <button
          data-testid="simulate-runtime-ready"
          onClick={() => runtime && onRuntimeReady?.(runtime)}
        />
      </div>
    ) : null,
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
    // clearAllMocks keeps return-value stubs — reset readiness to the ready default.
    mockUseRuntimeReadiness.mockReturnValue({ registered: true, ready: true, unsatisfiedDeps: [] });
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

  it('opens the runtime setup panel instead of navigating when the runtime needs setup', () => {
    mockUseSessions.mockReturnValue({ sessions: [], isLoading: false });
    mockUseRuntimeReadiness.mockReturnValue({
      registered: true,
      ready: false,
      unsatisfiedDeps: [{ name: 'OpenCode CLI' }],
    });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="opencode" />);

    fireEvent.click(screen.getByRole('button', { name: /start session/i }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', 'opencode');
  });

  it('launches the session once the runtime connects (onRuntimeReady)', () => {
    // The fix: connecting the not-ready runtime from the launch flow continues
    // the launch it interrupted, rather than stranding the user in the dialog.
    mockUseSessions.mockReturnValue({ sessions: [], isLoading: false });
    mockUseRuntimeReadiness.mockReturnValue({
      registered: true,
      ready: false,
      unsatisfiedDeps: [{ name: 'OpenCode CLI' }],
    });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="opencode" />);

    // Not ready → Start Session opens the setup dialog instead of navigating.
    fireEvent.click(screen.getByRole('button', { name: /start session/i }));
    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', 'opencode');

    // Connect succeeds → launch the session that was waiting on it, and close.
    fireEvent.click(screen.getByTestId('simulate-runtime-ready'));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: projectPath, runtime: 'opencode' },
    });
    expect(screen.queryByTestId('runtime-setup-dialog')).not.toBeInTheDocument();
  });

  it('gates New Session on runtime readiness too', () => {
    mockUseSessions.mockReturnValue({ sessions: makeSessions(1), isLoading: false });
    mockUseRuntimeReadiness.mockReturnValue({
      registered: true,
      ready: false,
      unsatisfiedDeps: [{ name: 'Codex CLI' }],
    });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="codex" />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));
    fireEvent.click(screen.getByRole('button', { name: /new session/i }));

    expect(mockNavigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', 'codex');
  });

  it('still opens existing sessions when the runtime needs setup', () => {
    // An existing session already runs — its history must stay reachable.
    mockUseSessions.mockReturnValue({ sessions: makeSessions(1), isLoading: false });
    mockUseRuntimeReadiness.mockReturnValue({
      registered: true,
      ready: false,
      unsatisfiedDeps: [{ name: 'Codex CLI' }],
    });

    render(<SessionLaunchPopover projectPath={projectPath} runtime="codex" />);

    fireEvent.click(screen.getByRole('button', { name: /open session/i }));
    const sessionRow = screen.getByText(/abcdef01/i).closest('button') as HTMLElement;
    fireEvent.click(sessionRow);

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { session: 'abcdef01-1234-5678-9abc-def012345678' },
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
