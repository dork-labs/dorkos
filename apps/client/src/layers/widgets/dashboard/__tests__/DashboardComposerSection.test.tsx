/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useAgentBirthStore } from '@/layers/shared/model';
import { DashboardComposerSection } from '../ui/DashboardComposerSection';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => mockNavigate }));

// The registered ABSOLUTE path (never the literal tilde) — the client can stream it.
const REGISTERED_DIR = '/home/kai/.dork/agents/dorkbot';
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
  }),
}));

vi.mock('@/layers/features/chat', () => ({
  ChatInput: ({
    value,
    onChange,
    onSubmit,
    placeholder,
  }: {
    value: string;
    onChange: (v: string) => void;
    onSubmit: () => void;
    placeholder?: string;
  }) => (
    <div>
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
}));

describe('DashboardComposerSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useAgentBirthStore.setState({ records: {} });
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the heading and a placeholder naming the default agent', () => {
    render(<DashboardComposerSection />);
    expect(screen.getByText('What are we building today?')).toBeInTheDocument();
    expect(screen.getByLabelText('Message DorkBot…')).toBeInTheDocument();
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
});
