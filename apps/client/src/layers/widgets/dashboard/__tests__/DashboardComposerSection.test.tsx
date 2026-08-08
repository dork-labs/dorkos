/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAgentBirthStore } from '@/layers/shared/model';
import { TOUR_ANCHORS } from '@/layers/shared/config';
import type { UseJumpBackInPopover } from '@/layers/features/jump-back-in';
import { DashboardComposerSection } from '../ui/DashboardComposerSection';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

// The "Jump back in" popover is stubbed shut for the same reason the composer
// is: this file is about the submit seam, and a live popover would drag the
// recents queries and their providers in with it. Its own behaviour — focus,
// keys, and where a row goes — is driven through the REAL composer in
// `DashboardComposerSection.jump-back-in.test.tsx`.
//
// Typed against the module, so the stub cannot silently fall behind the hook:
// a new handler the host wires would fail this file's typecheck rather than
// arriving here as `undefined` at runtime.
vi.mock('@/layers/features/jump-back-in', () => {
  const closed: UseJumpBackInPopover = {
    isOpen: false,
    hasRows: false,
    rows: [],
    agents: {},
    displayNames: {},
    visualOf: () => ({ kind: 'sigil' }),
    selectedIndex: 0,
    activeDescendantId: undefined,
    listboxId: undefined,
    handleFocus: vi.fn(),
    handleBlur: vi.fn(),
    handlePointerDown: vi.fn(),
    moveDown: vi.fn(),
    moveUp: vi.fn(),
    selectHighlighted: vi.fn(),
    selectRow: vi.fn(),
    dismiss: vi.fn(),
  };
  return {
    JumpBackInPopover: () => null,
    useJumpBackInPopover: () => closed,
  };
});

// The registered ABSOLUTE path (never the literal tilde) — the client can stream it.
const REGISTERED_DIR = '/home/kai/.dork/agents/dorkbot';
let mockResolved = true;
vi.mock('@/layers/entities/config', () => ({
  useDefaultAgentSession: () => ({
    startSession: vi.fn(),
    defaultAgentDir: REGISTERED_DIR,
    defaultAgentDisplayName: 'DorkBot',
    defaultAgentIdentity: {
      name: 'dorkbot',
      displayName: 'DorkBot',
      agentId: 'agent-ulid-1',
      runtime: 'claude-code',
    },
    isDefaultAgentResolved: mockResolved,
  }),
}));

// Stands in for the real composer, rendering the one thing these tests care
// about beyond the callbacks: the line that says why a send cannot happen yet.
vi.mock('@/layers/features/composer', () => ({
  Composer: {
    // A pass-through card. This file asserts the submit seam and the
    // agent-not-ready line, never the chrome — but it must forward `children`
    // or the wrap would render an empty section and every assertion below
    // would fail for the wrong reason.
    Root: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    Input: ({
      value,
      onChange,
      onSubmit,
      placeholder,
      canSubmit = true,
      canSubmitReason,
    }: {
      value: string;
      onChange: (v: string) => void;
      onSubmit: () => void;
      placeholder?: string;
      canSubmit?: boolean;
      canSubmitReason?: string;
    }) => (
      <div>
        {!canSubmit && canSubmitReason && <p>{canSubmitReason}</p>}
        <input
          data-testid="composer"
          aria-label={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button data-testid="send" onClick={onSubmit}>
          send
        </button>
      </div>
    ),
  },
}));

describe('DashboardComposerSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentBirthStore.setState({ records: {} });
    mockResolved = true;
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the heading and a placeholder naming the default agent', () => {
    render(<DashboardComposerSection />);
    expect(screen.getByText('What are we building today?')).toBeInTheDocument();
    expect(screen.getByLabelText('Message DorkBot…')).toBeInTheDocument();
  });

  it('stamps the tour anchor so the living tour can spotlight it', () => {
    render(<DashboardComposerSection />);
    expect(screen.getByTestId(TOUR_ANCHORS.dashboardComposer)).toBeInTheDocument();
  });

  it('registers a first-message birth record with the typed text and navigates', () => {
    render(<DashboardComposerSection />);

    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'Build me a blog' } });
    fireEvent.click(screen.getByTestId('send'));

    const records = Object.entries(useAgentBirthStore.getState().records);
    expect(records).toHaveLength(1);
    const [sessionId, record] = records[0]!;
    expect(sessionId).toMatch(/[0-9a-f-]{36}/i);
    expect(record).toMatchObject({
      kind: 'first-message',
      name: 'dorkbot',
      displayName: 'DorkBot',
      agentId: 'agent-ulid-1',
      path: REGISTERED_DIR,
      runtime: 'claude-code',
      kickoffMessage: 'Build me a blog',
    });

    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: REGISTERED_DIR, session: sessionId },
    });
  });

  it('trims whitespace from the registered message', () => {
    render(<DashboardComposerSection />);

    fireEvent.change(screen.getByTestId('composer'), { target: { value: '  hello  ' } });
    fireEvent.click(screen.getByTestId('send'));

    const record = Object.values(useAgentBirthStore.getState().records)[0];
    expect(record?.kickoffMessage).toBe('hello');
  });

  it('is a no-op on empty submit — no record, no navigation', () => {
    render(<DashboardComposerSection />);

    fireEvent.click(screen.getByTestId('send'));

    expect(Object.keys(useAgentBirthStore.getState().records)).toHaveLength(0);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('is a no-op when the input is only whitespace', () => {
    render(<DashboardComposerSection />);

    fireEvent.change(screen.getByTestId('composer'), { target: { value: '   ' } });
    fireEvent.click(screen.getByTestId('send'));

    expect(Object.keys(useAgentBirthStore.getState().records)).toHaveLength(0);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it('does not register or navigate before the default agent path resolves', () => {
    mockResolved = false;
    render(<DashboardComposerSection />);

    fireEvent.change(screen.getByTestId('composer'), { target: { value: 'Build me a blog' } });
    fireEvent.click(screen.getByTestId('send'));

    // Never start a session with the config-composed fallback path.
    expect(Object.keys(useAgentBirthStore.getState().records)).toHaveLength(0);
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  // The refusal above is correct and used to be completely silent: this is very
  // often the first sentence anyone types into DorkOS, and pressing Enter did
  // nothing with nothing on screen to explain it.
  it('says why the send is waiting while the default agent path resolves', () => {
    mockResolved = false;
    render(<DashboardComposerSection />);

    expect(screen.getByText('Getting your agent ready…')).toBeInTheDocument();
  });

  it('says nothing once the default agent path has resolved', () => {
    render(<DashboardComposerSection />);

    expect(screen.queryByText('Getting your agent ready…')).toBeNull();
  });
});
