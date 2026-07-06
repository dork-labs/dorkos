// @vitest-environment jsdom
import * as React from 'react';
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import '@testing-library/jest-dom/vitest';
import type { RuntimeCapabilities, SystemRequirements } from '@dorkos/shared/agent-runtime';
import type { Session } from '@dorkos/shared/types';

// ---------------------------------------------------------------------------
// Mocks. The runtime descriptor registry, isRuntimeReady, and
// PRIMARY_RUNTIME_TYPES stay REAL (importOriginal) so readiness gating and
// labels exercise the actual sources; only the data hooks are driven. Router
// navigation is captured so we can assert the fresh-session launch. The
// dropdown + setup dialog are stubbed to stay portal-free and observable.
// ---------------------------------------------------------------------------

const navigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => navigate,
}));

const mockSessions = vi.fn<() => { sessions: Session[] }>(() => ({ sessions: [] }));
vi.mock('@/layers/entities/session', () => ({
  useSessions: () => mockSessions(),
}));

type CapabilitiesMap = {
  capabilities: Record<string, RuntimeCapabilities>;
  defaultRuntime: string;
};
const mockCapabilities = vi.fn<() => { data: CapabilitiesMap | undefined }>(() => ({
  data: undefined,
}));
const mockRequirements = vi.fn<() => { data: SystemRequirements | undefined }>(() => ({
  data: undefined,
}));

vi.mock('@/layers/entities/runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/layers/entities/runtime')>()),
  useRuntimeCapabilities: () => mockCapabilities(),
  useRuntimeRequirements: () => mockRequirements(),
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

vi.mock('@/layers/features/runtime-connect', () => ({
  renderRuntimeConnect: () => null,
}));

vi.mock('@/layers/shared/ui', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    ResponsiveDropdownMenu: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-root">{children}</div>
    ),
    ResponsiveDropdownMenuTrigger: ({
      children,
    }: {
      children: React.ReactNode;
      asChild?: boolean;
    }) => <>{children}</>,
    ResponsiveDropdownMenuContent: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-content">{children}</div>
    ),
    ResponsiveDropdownMenuLabel: ({ children }: { children: React.ReactNode }) => (
      <div data-testid="dropdown-label">{children}</div>
    ),
    ResponsiveDropdownMenuItem: ({
      children,
      description,
      onSelect,
    }: {
      children: React.ReactNode;
      icon?: React.ComponentType;
      description?: string;
      onSelect?: () => void;
    }) => (
      <button data-testid="dropdown-item" data-description={description} onClick={onSelect}>
        <span>{children}</span>
      </button>
    ),
  };
});

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
  vi.clearAllMocks();
  mockSessions.mockReturnValue({ sessions: [] });
  mockCapabilities.mockReturnValue({ data: undefined });
  mockRequirements.mockReturnValue({ data: undefined });
});

// Import after mocks
import { RunWithMenu } from '../ui/message/RunWithMenu';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeCaps(...types: string[]): CapabilitiesMap {
  const one = (type: string): RuntimeCapabilities => ({
    type,
    supportsToolApproval: false,
    supportsCostTracking: false,
    supportsResume: false,
    supportsMcp: false,
    supportsQuestionPrompt: false,
    supportsPlugins: false,
    nativeContext: [],
    permissionModes: { supported: false, values: [] },
    features: {},
  });
  return {
    capabilities: Object.fromEntries(types.map((t) => [t, one(t)])),
    defaultRuntime: types[0],
  };
}

function requirementsFor(types: string[], missing: string[] = []): SystemRequirements {
  return {
    runtimes: Object.fromEntries(
      types.map((t) => [
        t,
        {
          dependencies: [
            {
              name: `${t} CLI`,
              description: `The ${t} binary.`,
              status: missing.includes(t) ? ('missing' as const) : ('satisfied' as const),
            },
          ],
        },
      ])
    ),
    allSatisfied: missing.length === 0,
  };
}

const CLAUDE_SESSION = {
  id: 'sess-claude',
  runtime: 'claude-code',
  cwd: '/repo',
  title: 'A session',
} as unknown as Session;

const PROMPT = 'Refactor the auth module';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RunWithMenu', () => {
  it('offers the sibling runtimes other than the current one', () => {
    mockSessions.mockReturnValue({ sessions: [CLAUDE_SESSION] });
    mockCapabilities.mockReturnValue({ data: makeCaps('claude-code', 'codex', 'opencode') });
    mockRequirements.mockReturnValue({
      data: requirementsFor(['claude-code', 'codex', 'opencode']),
    });

    render(<RunWithMenu prompt={PROMPT} sessionId="sess-claude" />);

    const items = screen.getAllByTestId('dropdown-item').map((el) => el.textContent);
    expect(items).toContain('Codex');
    expect(items).toContain('OpenCode');
    // The current runtime is not a "run this ELSEWHERE" target.
    expect(items).not.toContain('Claude Code');
  });

  it('re-runs the prompt into a FRESH session bound to the chosen runtime', async () => {
    mockSessions.mockReturnValue({ sessions: [CLAUDE_SESSION] });
    mockCapabilities.mockReturnValue({ data: makeCaps('claude-code', 'codex', 'opencode') });
    mockRequirements.mockReturnValue({
      data: requirementsFor(['claude-code', 'codex', 'opencode']),
    });
    const user = userEvent.setup();

    render(<RunWithMenu prompt={PROMPT} sessionId="sess-claude" />);

    const codex = screen.getAllByTestId('dropdown-item').find((el) => el.textContent === 'Codex')!;
    await user.click(codex);

    expect(navigate).toHaveBeenCalledTimes(1);
    const arg = navigate.mock.calls[0][0] as {
      to: string;
      search: { session: string; dir?: string; runtime: string; prompt: string };
    };
    expect(arg.to).toBe('/session');
    expect(arg.search.runtime).toBe('codex');
    expect(arg.search.prompt).toBe(PROMPT);
    // Same working directory as the origin session.
    expect(arg.search.dir).toBe('/repo');
    // A brand-new session id — NOT the origin session (no mutation, no transplant).
    expect(arg.search.session).toBeTruthy();
    expect(arg.search.session).not.toBe('sess-claude');
    // The setup dialog never opened — the target was Ready.
    expect(screen.queryByTestId('runtime-setup-dialog')).not.toBeInTheDocument();
  });

  it('opens Connect instead of launching when the target is not ready', async () => {
    mockSessions.mockReturnValue({ sessions: [CLAUDE_SESSION] });
    mockCapabilities.mockReturnValue({ data: makeCaps('claude-code', 'codex', 'opencode') });
    // Codex is registered but its dependency check is missing → not ready.
    mockRequirements.mockReturnValue({
      data: requirementsFor(['claude-code', 'codex', 'opencode'], ['codex']),
    });
    const user = userEvent.setup();

    render(<RunWithMenu prompt={PROMPT} sessionId="sess-claude" />);

    const codex = screen.getAllByTestId('dropdown-item').find((el) => el.textContent === 'Codex')!;
    expect(codex).toHaveAttribute('data-description', 'Connect');
    await user.click(codex);

    // Connect surface opened, scoped to codex; no launch happened.
    expect(screen.getByTestId('runtime-setup-dialog')).toHaveAttribute('data-runtime', 'codex');
    expect(navigate).not.toHaveBeenCalled();
  });

  it('resumes the fresh-session launch once the target connects', async () => {
    mockSessions.mockReturnValue({ sessions: [CLAUDE_SESSION] });
    mockCapabilities.mockReturnValue({ data: makeCaps('claude-code', 'codex', 'opencode') });
    // Codex not ready → Connect opens first, launch is deferred.
    mockRequirements.mockReturnValue({
      data: requirementsFor(['claude-code', 'codex', 'opencode'], ['codex']),
    });
    const user = userEvent.setup();

    render(<RunWithMenu prompt={PROMPT} sessionId="sess-claude" />);

    const codex = screen.getAllByTestId('dropdown-item').find((el) => el.textContent === 'Codex')!;
    await user.click(codex);
    expect(navigate).not.toHaveBeenCalled();

    // Connect succeeds → the same fresh-session launch runWith would have done.
    await user.click(screen.getByTestId('simulate-runtime-ready'));

    expect(navigate).toHaveBeenCalledTimes(1);
    const arg = navigate.mock.calls[0][0] as {
      to: string;
      search: { session: string; dir?: string; runtime: string; prompt: string };
    };
    expect(arg.to).toBe('/session');
    expect(arg.search.runtime).toBe('codex');
    expect(arg.search.prompt).toBe(PROMPT);
    expect(arg.search.dir).toBe('/repo');
    expect(arg.search.session).toBeTruthy();
    expect(arg.search.session).not.toBe('sess-claude');
    // The dialog closed after the launch resumed.
    expect(screen.queryByTestId('runtime-setup-dialog')).not.toBeInTheDocument();
  });

  it('does not mutate the current session — the re-run only navigates elsewhere', async () => {
    const sessions = [CLAUDE_SESSION];
    mockSessions.mockReturnValue({ sessions });
    mockCapabilities.mockReturnValue({ data: makeCaps('claude-code', 'opencode') });
    mockRequirements.mockReturnValue({ data: requirementsFor(['claude-code', 'opencode']) });
    const user = userEvent.setup();

    render(<RunWithMenu prompt={PROMPT} sessionId="sess-claude" />);

    const opencode = screen
      .getAllByTestId('dropdown-item')
      .find((el) => el.textContent === 'OpenCode')!;
    await user.click(opencode);

    // The origin session row is untouched (its runtime/cwd unchanged), and the
    // launch targets a different session id.
    expect(sessions[0]).toEqual(CLAUDE_SESSION);
    const arg = navigate.mock.calls[0][0] as { search: { session: string } };
    expect(arg.search.session).not.toBe('sess-claude');
  });
});
