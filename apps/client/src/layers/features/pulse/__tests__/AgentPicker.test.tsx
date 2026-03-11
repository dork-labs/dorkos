/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentPicker } from '../ui/AgentPicker';

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
  { id: 'agent-3', name: 'docs-writer', projectPath: '/projects/docs', icon: '📝', color: '#f59e0b' },
];

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false, media: query, onchange: null,
      addListener: vi.fn(), removeListener: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
    })),
  });
});

describe('AgentPicker', () => {
  afterEach(() => {
    cleanup();
  });

  describe('expanded state', () => {
    it('renders all agents as selectable rows', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByText('api-bot')).toBeInTheDocument();
      expect(screen.getByText('test-bot')).toBeInTheDocument();
      expect(screen.getByText('docs-writer')).toBeInTheDocument();
    });

    it('calls onValueChange when an agent row is clicked', () => {
      const onValueChange = vi.fn();
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={onValueChange} />);

      fireEvent.click(screen.getByText('api-bot'));
      expect(onValueChange).toHaveBeenCalledWith('agent-1');
    });
  });

  describe('collapsed state', () => {
    it('shows only the selected agent when value is set', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      expect(screen.getByText('api-bot')).toBeInTheDocument();
      expect(screen.queryByText('test-bot')).not.toBeInTheDocument();
      expect(screen.queryByText('docs-writer')).not.toBeInTheDocument();
    });

    it('shows pencil icon in collapsed state', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      expect(screen.getByLabelText('Change agent')).toBeInTheDocument();
    });

    it('expands when collapsed row is clicked', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      fireEvent.click(screen.getByLabelText('Change agent'));

      expect(screen.getByText('api-bot')).toBeInTheDocument();
      expect(screen.getByText('test-bot')).toBeInTheDocument();
      expect(screen.getByText('docs-writer')).toBeInTheDocument();
    });

    it('deselects agent when clicking the already-selected agent in expanded mode', () => {
      const onValueChange = vi.fn();
      render(
        <AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={onValueChange} />
      );

      // Expand
      fireEvent.click(screen.getByLabelText('Change agent'));

      // Click the already-selected agent
      fireEvent.click(screen.getByText('api-bot'));
      expect(onValueChange).toHaveBeenCalledWith(undefined);
    });
  });

  describe('empty state', () => {
    it('shows empty message when no agents exist', () => {
      render(<AgentPicker agents={[]} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByText(/No agents registered yet/)).toBeInTheDocument();
    });
  });

  describe('search filter', () => {
    it('shows search input when 8+ agents exist', () => {
      const manyAgents = Array.from({ length: 10 }, (_, i) => ({
        id: `agent-${i}`,
        name: `bot-${i}`,
        projectPath: `/projects/p${i}`,
      }));
      render(<AgentPicker agents={manyAgents} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByPlaceholderText('Search by name or path...')).toBeInTheDocument();
    });

    it('does not show search input when fewer than 8 agents', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.queryByPlaceholderText('Search by name or path...')).not.toBeInTheDocument();
    });

    it('filters agents by name when searching', () => {
      const manyAgents = Array.from({ length: 10 }, (_, i) => ({
        id: `agent-${i}`,
        name: `bot-${i}`,
        projectPath: `/projects/p${i}`,
      }));
      render(<AgentPicker agents={manyAgents} value={undefined} onValueChange={vi.fn()} />);

      fireEvent.change(screen.getByPlaceholderText('Search by name or path...'), {
        target: { value: 'bot-3' },
      });

      expect(screen.getByText('bot-3')).toBeInTheDocument();
      expect(screen.queryByText('bot-0')).not.toBeInTheDocument();
    });
  });
});
