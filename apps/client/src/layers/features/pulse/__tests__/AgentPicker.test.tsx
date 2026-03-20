/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { AgentPicker } from '../ui/AgentPicker';

const MOCK_AGENTS = [
  { id: 'agent-1', name: 'api-bot', projectPath: '/projects/api', icon: '🤖', color: '#6366f1' },
  { id: 'agent-2', name: 'test-bot', projectPath: '/projects/test', icon: '🧪', color: '#22c55e' },
  {
    id: 'agent-3',
    name: 'docs-writer',
    projectPath: '/projects/docs',
    icon: '📝',
    color: '#f59e0b',
  },
];

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
  // cmdk uses ResizeObserver and scrollIntoView internally
  globalThis.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});

describe('AgentPicker', () => {
  afterEach(() => {
    cleanup();
  });

  describe('trigger button', () => {
    it('shows placeholder when no agent is selected', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByText('Select an agent...')).toBeInTheDocument();
    });

    it('shows selected agent name in trigger', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={vi.fn()} />);

      expect(screen.getByText('api-bot')).toBeInTheDocument();
    });
  });

  describe('dropdown', () => {
    it('opens dropdown and shows all agents when trigger is clicked', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      fireEvent.click(screen.getByRole('button', { expanded: false }));

      expect(screen.getByText('api-bot')).toBeInTheDocument();
      expect(screen.getByText('test-bot')).toBeInTheDocument();
      expect(screen.getByText('docs-writer')).toBeInTheDocument();
    });

    it('calls onValueChange when an agent is selected', () => {
      const onValueChange = vi.fn();
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={onValueChange} />);

      fireEvent.click(screen.getByRole('button', { expanded: false }));
      fireEvent.click(screen.getByText('api-bot'));

      expect(onValueChange).toHaveBeenCalledWith('agent-1');
    });

    it('deselects agent when clicking the already-selected agent', () => {
      const onValueChange = vi.fn();
      render(<AgentPicker agents={MOCK_AGENTS} value="agent-1" onValueChange={onValueChange} />);

      fireEvent.click(screen.getByRole('button'));
      // In the dropdown, click the already-selected agent
      fireEvent.click(screen.getAllByText('api-bot')[1]);

      expect(onValueChange).toHaveBeenCalledWith(undefined);
    });

    it('shows search input in dropdown', () => {
      render(<AgentPicker agents={MOCK_AGENTS} value={undefined} onValueChange={vi.fn()} />);

      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByPlaceholderText('Search agents...')).toBeInTheDocument();
    });
  });

  describe('empty state', () => {
    it('shows empty message when no agents exist', () => {
      render(<AgentPicker agents={[]} value={undefined} onValueChange={vi.fn()} />);

      expect(screen.getByText(/No agents registered yet/)).toBeInTheDocument();
    });
  });
});
