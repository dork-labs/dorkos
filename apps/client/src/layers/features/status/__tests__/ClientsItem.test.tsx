// @vitest-environment jsdom
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ClientsItem } from '../ui/ClientsItem';

// Mock Radix Popover portal to render inline in jsdom
vi.mock('radix-ui', async () => {
  const actual = await vi.importActual<typeof import('radix-ui')>('radix-ui');
  return {
    ...actual,
    Popover: {
      ...actual.Popover,
      Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    },
  };
});

// Mock motion/react to avoid animation issues in tests
vi.mock('motion/react', () => ({
  motion: {
    span: ({ children, ...props }: React.HTMLAttributes<HTMLSpanElement>) => (
      <span {...props}>{children}</span>
    ),
  },
  AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const webClient = { type: 'web' as const, connectedAt: new Date().toISOString() };
const obsidianClient = {
  type: 'obsidian' as const,
  connectedAt: new Date(Date.now() - 120_000).toISOString(),
};

const baseProps = {
  clientCount: 2,
  clients: [webClient, obsidianClient],
  lockInfo: null,
  pulse: false,
};

describe('ClientsItem', () => {
  describe('default (unlocked) state', () => {
    it('renders client count text', () => {
      render(<ClientsItem {...baseProps} />);
      expect(screen.getByText('2 clients')).toBeInTheDocument();
    });

    it('has accessible label with client count', () => {
      render(<ClientsItem {...baseProps} />);
      expect(screen.getByLabelText('2 clients connected')).toBeInTheDocument();
    });

    it('renders with different client counts', () => {
      render(<ClientsItem {...baseProps} clientCount={3} />);
      expect(screen.getByText('3 clients')).toBeInTheDocument();
    });

    it('renders a trigger button', () => {
      render(<ClientsItem {...baseProps} />);
      expect(screen.getByRole('button')).toBeInTheDocument();
    });
  });

  describe('locked state', () => {
    const lockedProps = {
      ...baseProps,
      lockInfo: { clientId: 'web-abc', acquiredAt: new Date().toISOString() },
    };

    it('updates aria-label to include lock status', () => {
      render(<ClientsItem {...lockedProps} />);
      expect(screen.getByLabelText('2 clients connected, session locked')).toBeInTheDocument();
    });

    it('applies amber text color when locked', () => {
      render(<ClientsItem {...lockedProps} />);
      // The amber class is on the motion.span wrapper, two levels up from the text node
      const badge = screen.getByText('2 clients').closest('[class*="text-amber"]');
      expect(badge).toBeInTheDocument();
    });
  });

  describe('popover content', () => {
    it('shows connected clients heading on open', () => {
      render(<ClientsItem {...baseProps} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Connected clients')).toBeInTheDocument();
    });

    it('lists friendly client type labels', () => {
      render(<ClientsItem {...baseProps} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Web browser')).toBeInTheDocument();
      expect(screen.getByText('Obsidian plugin')).toBeInTheDocument();
    });

    it('shows lock notice in popover when locked', () => {
      render(
        <ClientsItem
          {...baseProps}
          lockInfo={{ clientId: 'web-abc', acquiredAt: new Date().toISOString() }}
        />
      );
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Locked by another client')).toBeInTheDocument();
    });

    it('does not show lock notice when not locked', () => {
      render(<ClientsItem {...baseProps} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.queryByText('Locked by another client')).not.toBeInTheDocument();
    });

    it('shows relative time for recent client as "just now"', () => {
      const recentClients = [{ type: 'web' as const, connectedAt: new Date().toISOString() }];
      render(<ClientsItem {...baseProps} clients={recentClients} clientCount={1} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('just now')).toBeInTheDocument();
    });

    it('shows relative time in minutes for older client', () => {
      const oldClients = [
        {
          type: 'mcp' as const,
          connectedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
        },
      ];
      render(<ClientsItem {...baseProps} clients={oldClients} clientCount={1} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('5m ago')).toBeInTheDocument();
    });
  });

  describe('client type labels', () => {
    it('renders "External client" label for mcp type', () => {
      const mcpClients = [{ type: 'mcp' as const, connectedAt: new Date().toISOString() }];
      render(<ClientsItem {...baseProps} clients={mcpClients} clientCount={1} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('External client')).toBeInTheDocument();
    });

    it('renders "Unknown client" label for unknown type', () => {
      const unknownClients = [{ type: 'unknown' as const, connectedAt: new Date().toISOString() }];
      render(<ClientsItem {...baseProps} clients={unknownClients} clientCount={1} />);
      fireEvent.click(screen.getByRole('button'));
      expect(screen.getByText('Unknown client')).toBeInTheDocument();
    });
  });
});
