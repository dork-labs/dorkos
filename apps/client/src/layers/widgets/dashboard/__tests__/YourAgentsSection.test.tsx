/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import type { DashboardAgentCard } from '../lib/order-agent-cards';
import { YourAgentsSection } from '../ui/YourAgentsSection';

const mockNavigate = vi.fn();
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => mockNavigate,
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => (
    <a href={to}>{children}</a>
  ),
}));

let mockCards: DashboardAgentCard[] = [];
vi.mock('../model/use-dashboard-agents', () => ({
  useDashboardAgents: () => ({ cards: mockCards, defaultAgentDir: '/agents/default' }),
}));

function card(path: string, overrides: Partial<DashboardAgentCard> = {}): DashboardAgentCard {
  return {
    path,
    displayName: path.split('/').pop() ?? path,
    color: '#6366f1',
    emoji: '🤖',
    attention: 'inactive',
    lastActivityIso: null,
    ...overrides,
  };
}

describe('YourAgentsSection', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCards = [];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders nothing when there are no agents', () => {
    const { container } = render(<YourAgentsSection />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders a card per agent with its name and human status', () => {
    mockCards = [card('/agents/default', { displayName: 'DorkBot', attention: 'fresh' })];
    render(<YourAgentsSection />);
    expect(screen.getByText('DorkBot')).toBeInTheDocument();
    expect(screen.getByText('New, say hello')).toBeInTheDocument();
  });

  it('opens a session with the agent when its card is clicked', () => {
    mockCards = [card('/agents/writer', { displayName: 'Writer' })];
    render(<YourAgentsSection />);
    fireEvent.click(screen.getByRole('button', { name: 'Open a session with Writer' }));
    expect(mockNavigate).toHaveBeenCalledWith({
      to: '/session',
      search: { dir: '/agents/writer' },
    });
  });

  it('caps at six cards and shows an overflow link to /agents', () => {
    mockCards = Array.from({ length: 7 }, (_, i) => card(`/agents/a${i}`));
    render(<YourAgentsSection />);
    const cards = screen.getAllByRole('button', { name: /Open a session with/ });
    expect(cards).toHaveLength(6);
    const link = screen.getByRole('link', { name: /all agents/i });
    expect(link).toHaveAttribute('href', '/agents');
  });

  it('shows no overflow link when six or fewer agents exist', () => {
    mockCards = Array.from({ length: 6 }, (_, i) => card(`/agents/a${i}`));
    render(<YourAgentsSection />);
    expect(screen.queryByRole('link', { name: /all agents/i })).not.toBeInTheDocument();
  });
});
