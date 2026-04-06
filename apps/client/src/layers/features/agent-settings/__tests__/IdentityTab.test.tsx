// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import { TooltipProvider } from '@/layers/shared/ui';
import type { AgentManifest } from '@dorkos/shared/mesh-schemas';

import { IdentityTab } from '../ui/IdentityTab';

// Mock matchMedia for responsive popover components
beforeEach(() => {
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

const baseAgent: AgentManifest = {
  id: '01HZ0000000000000000000001',
  name: 'test-agent',
  description: 'A mock agent',
  runtime: 'claude-code',
  capabilities: ['code-review', 'testing'],
  behavior: { responseMode: 'always' },
  budget: { maxHopsPerMessage: 5, maxCallsPerHour: 100 },
  registeredAt: '2025-01-01T00:00:00.000Z',
  registeredBy: 'test',
  personaEnabled: true,
  enabledToolGroups: {},
};

function renderTab(agent: AgentManifest, onUpdate: ReturnType<typeof vi.fn>) {
  const { container } = render(
    <TooltipProvider>
      <IdentityTab agent={agent} onUpdate={onUpdate} />
    </TooltipProvider>
  );
  return within(container);
}

describe('IdentityTab', () => {
  let onUpdate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    onUpdate = vi.fn();
  });

  describe('Tags section', () => {
    it('renders existing tags as badges', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('code-review')).toBeInTheDocument();
      expect(view.getByText('testing')).toBeInTheDocument();
    });

    it('adds a tag when Enter is pressed', () => {
      const view = renderTab(baseAgent, onUpdate);
      const input = view.getByPlaceholderText('Add tag and press Enter');
      fireEvent.change(input, { target: { value: 'deployment' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onUpdate).toHaveBeenCalledWith({
        capabilities: ['code-review', 'testing', 'deployment'],
      });
    });

    it('does not add duplicate tags', () => {
      const view = renderTab(baseAgent, onUpdate);
      const input = view.getByPlaceholderText('Add tag and press Enter');
      fireEvent.change(input, { target: { value: 'code-review' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('does not add empty tags', () => {
      const view = renderTab(baseAgent, onUpdate);
      const input = view.getByPlaceholderText('Add tag and press Enter');
      fireEvent.keyDown(input, { key: 'Enter' });
      expect(onUpdate).not.toHaveBeenCalled();
    });

    it('removes a tag when X button is clicked', () => {
      const view = renderTab(baseAgent, onUpdate);
      const removeBtn = view.getByLabelText('Remove code-review');
      fireEvent.click(removeBtn);
      expect(onUpdate).toHaveBeenCalledWith({
        capabilities: ['testing'],
      });
    });

    it('shows helper text when no tags exist', () => {
      const view = renderTab({ ...baseAgent, capabilities: [] }, onUpdate);
      expect(
        view.getByText(
          'Tags help other agents find this one. Examples: code-review, devops, frontend'
        )
      ).toBeInTheDocument();
    });
  });

  describe('Runtime section', () => {
    it('renders runtime selector with current value', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Claude Code')).toBeInTheDocument();
    });

    it('renders runtime label', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Runtime')).toBeInTheDocument();
    });
  });

  describe('Project Group section', () => {
    it('renders Advanced collapsible', () => {
      const view = renderTab(baseAgent, onUpdate);
      expect(view.getByText('Advanced')).toBeInTheDocument();
    });

    it('debounces project group input and calls onUpdate after delay', () => {
      vi.useFakeTimers();
      const view = renderTab(baseAgent, onUpdate);

      // Expand the Advanced section
      fireEvent.click(view.getByText('Advanced'));

      const input = view.getByPlaceholderText('e.g. backend-services');
      fireEvent.change(input, { target: { value: 'my-group' } });

      expect(onUpdate).not.toHaveBeenCalled();

      vi.advanceTimersByTime(500);
      expect(onUpdate).toHaveBeenCalledWith({ namespace: 'my-group' });

      vi.useRealTimers();
    });
  });
});
